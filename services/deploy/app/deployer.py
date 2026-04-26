"""배포 파이프라인 — 5단계 배포 로직 (SSH 원격 배포)"""
import asyncio
import json
import ipaddress
import re
import shlex
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import redis
import requests

from app.config import settings
from app.health_contract import run_health_contract
from app.ssh_executor import SSHExecutor, save_docker_image, validate_ssh_credentials

_executor = ThreadPoolExecutor(max_workers=4)

# 플래그 read-only 마운트 기준 경로
FLAG_BASE_DIR = "/opt/cstrike-flags"


@dataclass
class TeamInfo:
    team_id: str
    team_code: str
    name: str
    subnet: str | None = None
    gateway_ip: str | None = None
    competition_id: str = ""
    ssh_port: int = 22
    ssh_user: str | None = None
    ssh_password: str | None = None


@dataclass
class ServiceInfo:
    service_id: str
    name: str
    docker_image: str
    container_port: int
    health_check_endpoint: str | None = None
    healthcheck_scenarios: dict | None = None
    env_vars: dict | None = None
    flag_slots: list[dict] | None = None


@dataclass
class StageResult:
    success: bool
    log: str = ""
    error: str | None = None


def _get_redis_client() -> redis.Redis:
    return redis.from_url(settings.REDIS_URL)


def _publish_stage_progress(
    redis_client: redis.Redis,
    pipeline_id: str,
    stage_name: str,
    status: str,
    log_output: str = "",
    error_detail: str | None = None,
):
    """단계 진행 상태를 Redis로 발행한다."""
    payload = json.dumps({
        "pipeline_id": pipeline_id,
        "stage_name": stage_name,
        "status": status,
        "log_output": log_output,
        "error_detail": error_detail,
        "timestamp": time.time(),
    })
    redis_client.publish("deploy:stage:progress", payload)


def _publish_pipeline_done(
    redis_client: redis.Redis,
    pipeline_id: str,
    status: str,
    error_detail: str | None = None,
):
    """파이프라인 완료 이벤트를 Redis로 발행한다."""
    payload = json.dumps({
        "pipeline_id": pipeline_id,
        "status": status,
        "error_detail": error_detail,
        "timestamp": time.time(),
    })
    redis_client.publish("deploy:pipeline:done", payload)


def _update_team_service(team_id: str, service_id: str, data: dict):
    """ops-backend에 TeamService 상태를 HTTP 콜백으로 업데이트한다."""
    url = f"{settings.OPS_BACKEND_URL}/api/v1/internal/team-services/{team_id}/{service_id}"
    headers = {"X-Internal-API-Key": settings.INTERNAL_API_KEY}
    try:
        resp = requests.put(url, json=data, headers=headers, timeout=10)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 콜백 실패는 로그만 남기고 배포 자체를 실패시키지 않는다
        print(f"[경고] TeamService 콜백 실패: {e}")


def _safe_service_slug(name: str) -> str:
    """Docker 컨테이너 이름에 쓸 수 있는 안전한 서비스 slug를 만든다."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-")
    return slug or "service"


def _safe_team_runtime_slug(team_code: str) -> str:
    """런타임 리소스 이름에 쓸 수 있는 안전한 팀 slug를 만든다."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", (team_code or "").lower()).strip("-")
    return slug or "team"


def _sanitize_flag_filename(value: str | None, fallback_key: str) -> str:
    raw = (value or "").strip()
    if not raw:
        raw = f"flag-{fallback_key}.txt"
    name = raw.rsplit("/", 1)[-1].replace("\\", "")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    if not name:
        name = f"flag-{fallback_key}.txt"
    if not name.lower().endswith(".txt"):
        name = f"{name}.txt"
    return name


def _normalize_flag_slots(service: ServiceInfo) -> list[dict]:
    slots = service.flag_slots or [
        {
            "slot_key": "flag-1",
            "label": "플래그 1",
            "filename": "flag.txt",
            "points": 100,
        }
    ]
    normalized: list[dict] = []
    for index, slot in enumerate(slots):
        slot = slot or {}
        slot_key = re.sub(
            r"[^a-z0-9._-]+",
            "-",
            str(slot.get("slot_key") or slot.get("filename") or slot.get("label") or f"flag-{index+1}").strip().lower(),
        ).strip("-") or f"flag-{index+1}"
        normalized.append(
            {
                "slot_key": slot_key,
                "label": str(slot.get("label") or f"플래그 {index + 1}").strip() or f"플래그 {index + 1}",
                "filename": _sanitize_flag_filename(slot.get("filename"), slot_key),
                "points": int(slot.get("points") or 100),
            }
        )
    return normalized


def _container_name(team: TeamInfo, service: ServiceInfo) -> str:
    return f"cstrike-{_safe_team_runtime_slug(team.team_code)}-{_safe_service_slug(service.name)}"


def _derive_battlefield_bind_ip(team: TeamInfo) -> str:
    """팀 서버의 경기망 서비스 바인딩 IP를 계산한다.

    우선순위:
    1) 팀 VPN subnet(예: 10.88.1.0/24) 의 3번째 옥텟을 재사용해 10.1.<n>.10 생성
    2) gateway_ip(예: 10.2.1.10) 를 같은 호스트의 10.1.<n>.10 으로 변환
    3) 불가능하면 모든 인터페이스(0.0.0.0) 바인딩으로 fallback
    """
    if team.subnet:
        try:
            net = ipaddress.ip_network(team.subnet, strict=False)
            octets = str(net.network_address).split(".")
            if len(octets) == 4:
                return f"10.1.{int(octets[2])}.10"
        except ValueError:
            pass

    if team.gateway_ip:
        try:
            addr = ipaddress.ip_address(team.gateway_ip)
            octets = str(addr).split(".")
            if len(octets) == 4:
                return f"10.1.{int(octets[2])}.10"
        except ValueError:
            pass

    return "0.0.0.0"


# ──────────────────────────────────────────────
# 5단계 파이프라인 함수 (모두 동기)
# ──────────────────────────────────────────────

def stage_register_sync(service: ServiceInfo) -> StageResult:
    """1단계: 이미지 등록 확인 — 로컬에 이미지가 존재하는지 검증한다."""
    import docker
    try:
        client = docker.from_env()
        image = client.images.get(service.docker_image)
        return StageResult(
            success=True,
            log=f"이미지 확인 완료: {service.docker_image} (ID: {image.short_id})",
        )
    except docker.errors.ImageNotFound:
        return StageResult(success=False, error=f"이미지를 찾을 수 없습니다: {service.docker_image}")
    except Exception as e:
        return StageResult(success=False, error=str(e))


def stage_validate_sync(service: ServiceInfo, teams: list[TeamInfo]) -> StageResult:
    """2단계: SSH 접속 검증 — 모든 팀 서버에 SSH 연결 가능한지 확인한다."""
    logs = []
    errors = []
    for team in teams:
        cred_error = validate_ssh_credentials(team)
        if cred_error:
            errors.append(cred_error)
            continue
        try:
            with SSHExecutor(team.gateway_ip, team.ssh_port, team.ssh_user, team.ssh_password) as ssh:
                result = ssh.exec("docker --version")
                if result.success:
                    logs.append(f"  {team.team_code}: SSH 연결 성공 ({result.stdout.strip()})")
                else:
                    errors.append(f"팀 {team.team_code}: Docker 미설치 또는 접근 불가 ({result.stderr.strip()})")
        except Exception as e:
            errors.append(f"팀 {team.team_code}: SSH 연결 실패 ({e})")
    log_text = f"{len(teams)}개 팀 SSH 검증\n" + "\n".join(logs)
    if errors:
        log_text += "\n실패:\n" + "\n".join(f"  {e}" for e in errors)
        return StageResult(success=False, log=log_text, error="; ".join(errors))
    return StageResult(success=True, log=log_text)


def stage_prepare_sync(service: ServiceInfo, teams: list[TeamInfo]) -> StageResult:
    """3단계: 이미지 전송 — 로컬 이미지를 각 팀 서버로 전송한다."""
    import os
    tar_path: str | None = None
    logs = []
    errors = []
    try:
        tar_path = save_docker_image(service.docker_image)
        size_mb = os.path.getsize(tar_path) / (1024 * 1024)
        logs.append(f"이미지 tar 생성 완료: {service.docker_image} ({size_mb:.1f} MB)")
        for team in teams:
            try:
                with SSHExecutor(team.gateway_ip, team.ssh_port, team.ssh_user, team.ssh_password) as ssh:
                    remote_path = "/tmp/cstrike-image.tar"
                    ssh.transfer_file(tar_path, remote_path)
                    logs.append(f"  {team.team_code}: 이미지 전송 완료")
                    result = ssh.exec(
                        f"docker load -i {remote_path} && rm -f {remote_path}",
                        timeout=settings.SSH_TRANSFER_TIMEOUT,
                    )
                    if result.success:
                        logs.append(f"  {team.team_code}: docker load 완료")
                    else:
                        errors.append(f"팀 {team.team_code}: docker load 실패 ({result.stderr.strip()})")
            except Exception as e:
                errors.append(f"팀 {team.team_code}: 이미지 전송 실패 ({e})")
    except Exception as e:
        return StageResult(success=False, error=f"이미지 tar 생성 실패: {e}")
    finally:
        if tar_path and os.path.exists(tar_path):
            os.unlink(tar_path)
            parent = os.path.dirname(tar_path)
            if os.path.isdir(parent):
                os.rmdir(parent)
    log_text = "\n".join(logs)
    if errors:
        log_text += "\n실패:\n" + "\n".join(f"  {e}" for e in errors)
        return StageResult(success=False, log=log_text, error="; ".join(errors))
    return StageResult(success=True, log=log_text)


def build_run_command(service: ServiceInfo, team: TeamInfo) -> str:
    """docker run 명령어를 구성한다. 플래그 디렉터리는 read-only 마운트."""
    container_name = _container_name(team, service)
    flag_dir = f"{FLAG_BASE_DIR}/{container_name}"
    flag_slots = _normalize_flag_slots(service)
    canonical_flag = flag_slots[0]
    canonical_flag_path = f"{flag_dir}/{canonical_flag['filename']}"
    host_port = service.container_port
    bind_ip = _derive_battlefield_bind_ip(team)

    runtime_env = {
        "CSTRIKE_TEAM_ID": team.team_id,
        "CSTRIKE_TEAM_CODE": team.team_code,
        "CSTRIKE_TEAM_NAME": team.name,
        "CSTRIKE_TEAM_SUBNET": team.subnet or "",
        "CSTRIKE_TEAM_GATEWAY_IP": team.gateway_ip or "",
        "CSTRIKE_COMPETITION_ID": team.competition_id,
        "CSTRIKE_SERVICE_ID": service.service_id,
        "CSTRIKE_SERVICE_NAME": service.name,
    }
    if service.env_vars:
        runtime_env.update(service.env_vars)

    env_args = ""
    for k, v in runtime_env.items():
        env_args += f" -e {shlex.quote(f'{k}={v}')}"

    quoted_name = shlex.quote(container_name)
    quoted_flag_dir = shlex.quote(flag_dir)
    quoted_canonical_flag_path = shlex.quote(canonical_flag_path)
    quoted_team_id = shlex.quote(team.team_id)
    quoted_team_code = shlex.quote(team.team_code)
    quoted_service_id = shlex.quote(service.service_id)
    quoted_service_name = shlex.quote(service.name)
    quoted_competition_id = shlex.quote(team.competition_id)
    quoted_image = shlex.quote(service.docker_image)

    return (
        f"docker run -d"
        f" --name {quoted_name}"
        f" --restart unless-stopped"
        f" -p {bind_ip}:{host_port}:{service.container_port}"
        f" -v {quoted_flag_dir}:/flags:ro"
        f" -v {quoted_canonical_flag_path}:/flag.txt:ro"
        f"{env_args}"
        f" --label cstrike-service=true"
        f" --label cstrike-team-id={quoted_team_id}"
        f" --label cstrike-team-code={quoted_team_code}"
        f" --label cstrike-service-id={quoted_service_id}"
        f" --label cstrike-service-name={quoted_service_name}"
        f" --label cstrike-competition-id={quoted_competition_id}"
        f" {quoted_image}"
    )


def _deploy_to_team(service: ServiceInfo, team: TeamInfo) -> dict:
    """단일 팀 서버에 SSH로 접속하여 Docker 컨테이너를 배포한다."""
    container_name = _container_name(team, service)
    host_port = service.container_port
    bind_ip = _derive_battlefield_bind_ip(team)
    flag_dir = f"{FLAG_BASE_DIR}/{container_name}"
    flag_slots = _normalize_flag_slots(service)

    with SSHExecutor(team.gateway_ip, team.ssh_port, team.ssh_user, team.ssh_password) as ssh:
        ssh.exec(f"docker rm -f {container_name} 2>/dev/null || true")
        prep_parts = [f"mkdir -p {shlex.quote(flag_dir)}", f"chmod 755 {shlex.quote(flag_dir)}"]
        for slot in flag_slots:
            slot_path = f"{flag_dir}/{slot['filename']}"
            placeholder_flag = (
                f"FLAG{{bootstrap-{_safe_team_runtime_slug(team.team_code)}-{_safe_service_slug(service.name)}-{slot['slot_key']}}}"
            )
            prep_parts.extend(
                [
                    f"if [ -d {shlex.quote(slot_path)} ]; then rm -rf {shlex.quote(slot_path)}; fi",
                    f"touch {shlex.quote(slot_path)}",
                    f"if [ ! -s {shlex.quote(slot_path)} ]; then printf '%s\\n' {shlex.quote(placeholder_flag)} > {shlex.quote(slot_path)}; fi",
                    f"chown {shlex.quote(team.ssh_user)}:{shlex.quote(team.ssh_user)} {shlex.quote(slot_path)}",
                    f"chmod 664 {shlex.quote(slot_path)}",
                ]
            )
        prep_parts.append(
            f"chown {shlex.quote(team.ssh_user)}:{shlex.quote(team.ssh_user)} {shlex.quote(flag_dir)}"
        )
        prep_inner = " && ".join(prep_parts)
        prep_cmd = (
            f"printf '%s\\n' {shlex.quote(team.ssh_password)} | "
            f"sudo -S -p '' sh -lc {shlex.quote(prep_inner)}"
        )
        prep_result = ssh.exec(prep_cmd)
        if not prep_result.success:
            raise RuntimeError(f"flag 경로 준비 실패: {prep_result.stderr.strip()}")
        run_cmd = build_run_command(service, team)
        result = ssh.exec(run_cmd)
        if not result.success:
            raise RuntimeError(f"docker run 실패: {result.stderr.strip()}")
        container_id = result.stdout.strip()[:12]
        post_setup_cmd = """
if [ -x /docker-entrypoint.d/40-cstrike-setup.sh ]; then
  /docker-entrypoint.d/40-cstrike-setup.sh
elif [ -x /usr/local/bin/40-cstrike-bootstrap.sh ]; then
  /usr/local/bin/40-cstrike-bootstrap.sh
else
  exit 0
fi
""".strip()
        post_setup = ssh.exec(
            f"docker exec {shlex.quote(container_name)} sh -lc "
            f"{shlex.quote(post_setup_cmd)}"
        )
        if not post_setup.success:
            raise RuntimeError(f"컨테이너 후처리 실패: {post_setup.stderr.strip()}")

    _update_team_service(team.team_id, service.service_id, {
        "host_ip": bind_ip,
        "port": host_port,
        "container_id": container_id,
        "status": "running",
    })
    return {
        "team_code": team.team_code,
        "container_id": container_id,
        "container_name": container_name,
        "host_port": host_port,
        "status": "running",
    }


def stage_deploy_sync(service: ServiceInfo, teams: list[TeamInfo]) -> StageResult:
    """4단계: 컨테이너 배포 — 각 팀에 서비스 컨테이너를 생성한다."""
    results = []
    errors = []

    # 최대 5개 팀 동시 배포
    with ThreadPoolExecutor(max_workers=settings.DEPLOY_MAX_CONCURRENT) as pool:
        futures = {
            pool.submit(_deploy_to_team, service, team): team
            for team in teams
        }
        for future in futures:
            team = futures[future]
            try:
                result = future.result(timeout=120)
                results.append(result)
            except Exception as e:
                errors.append(f"팀 {team.team_code} 배포 실패: {e}")

    logs = [f"  {r['team_code']}: {r['container_name']} (포트: {r['host_port']})" for r in results]
    log_text = f"{len(results)}/{len(teams)}개 팀 배포 완료\n" + "\n".join(logs)

    if errors:
        log_text += "\n실패 목록:\n" + "\n".join(f"  {e}" for e in errors)

    if errors and not results:
        return StageResult(success=False, log=log_text, error="모든 팀 배포 실패")

    return StageResult(success=len(errors) == 0, log=log_text, error="; ".join(errors) if errors else None)


def stage_verify_sync(service: ServiceInfo, teams: list[TeamInfo]) -> StageResult:
    """5단계: 배포 검증 — 각 팀 서버에서 컨테이너 상태를 확인한다."""
    healthy_count = 0
    total_count = len(teams)
    logs = []
    for team in teams:
        container_name = _container_name(team, service)
        bind_ip = _derive_battlefield_bind_ip(team)
        try:
            with SSHExecutor(team.gateway_ip, team.ssh_port, team.ssh_user, team.ssh_password) as ssh:
                result = ssh.exec(f"docker inspect --format '{{{{.State.Status}}}}' {container_name}")
                if not result.success:
                    logs.append(f"  {team.team_code}: 컨테이너를 찾을 수 없음")
                    continue
                container_status = result.stdout.strip()
                if container_status != "running":
                    logs.append(f"  {team.team_code}: 실행 중이 아님 (상태: {container_status})")
                    continue
                if service.healthcheck_scenarios and service.healthcheck_scenarios.get("steps"):
                    ok, _, scenario_error = asyncio.run(
                        run_health_contract(
                            f"http://{bind_ip}:{service.container_port}",
                            service.healthcheck_scenarios,
                        )
                    )
                    if ok:
                        healthy_count += 1
                        logs.append(f"  {team.team_code}: 시나리오 검증 성공")
                    else:
                        logs.append(f"  {team.team_code}: 시나리오 검증 실패 ({scenario_error})")
                elif service.health_check_endpoint:
                    hc_cmd = (
                        f"curl -sf -o /dev/null -w '%{{http_code}}'"
                        f" http://{bind_ip}:{service.container_port}{service.health_check_endpoint}"
                        f" --connect-timeout 5 --max-time 10"
                    )
                    hc_result = ssh.exec(hc_cmd)
                    if hc_result.success:
                        http_code = hc_result.stdout.strip()
                        if int(http_code) < 500:
                            healthy_count += 1
                            logs.append(f"  {team.team_code}: 정상 (HTTP {http_code})")
                        else:
                            logs.append(f"  {team.team_code}: 응답 이상 (HTTP {http_code})")
                    else:
                        logs.append(f"  {team.team_code}: 헬스체크 실패 (curl 오류)")
                else:
                    healthy_count += 1
                    logs.append(f"  {team.team_code}: running 상태 확인")
        except Exception as e:
            logs.append(f"  {team.team_code}: 검증 오류 ({e})")
    log_text = f"검증 결과: {healthy_count}/{total_count}개 정상\n" + "\n".join(logs)
    if healthy_count == total_count:
        return StageResult(success=True, log=log_text)
    return StageResult(success=False, log=log_text, error=f"{total_count - healthy_count}개 팀 검증 실패")


# ──────────────────────────────────────────────
# 파이프라인 실행
# ──────────────────────────────────────────────

PIPELINE_STAGES = [
    ("register", stage_register_sync, False),   # (이름, 함수, teams 필요 여부)
    ("validate", stage_validate_sync, True),
    ("prepare", stage_prepare_sync, True),
    ("deploy", stage_deploy_sync, True),
    ("verify", stage_verify_sync, True),
]


def run_pipeline_sync(
    pipeline_id: str,
    service: ServiceInfo,
    teams: list[TeamInfo],
):
    """5단계 파이프라인을 순차 실행한다."""
    redis_client = _get_redis_client()

    try:
        for stage_name, stage_fn, needs_teams in PIPELINE_STAGES:
            _publish_stage_progress(redis_client, pipeline_id, stage_name, "running")

            try:
                if needs_teams:
                    result = stage_fn(service, teams)
                else:
                    result = stage_fn(service)
            except Exception as e:
                result = StageResult(success=False, error=str(e))

            # 상태값 규칙: ops-backend _handle_stage_progress / 프론트 PIPELINE_STATUS_MAP은
            # 모두 "success"를 기대한다. "completed"를 쓰면 completed_at 저장 조건에서도 탈락하고
            # 프론트는 "알 수 없음" 배지 + 빈 스텝 노드로 표시되므로 반드시 "success"로 발행한다.
            status = "success" if result.success else "failed"
            _publish_stage_progress(
                redis_client, pipeline_id, stage_name, status,
                log_output=result.log,
                error_detail=result.error,
            )

            if not result.success:
                _publish_pipeline_done(
                    redis_client, pipeline_id, "failed",
                    error_detail=f"{stage_name} 단계 실패: {result.error}",
                )
                return

        _publish_pipeline_done(redis_client, pipeline_id, "success")

    finally:
        redis_client.close()


async def run_pipeline(
    pipeline_id: str,
    service: ServiceInfo,
    teams: list[TeamInfo],
):
    """비동기 래퍼 — BackgroundTasks에서 호출된다."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        _executor, run_pipeline_sync, pipeline_id, service, teams
    )
