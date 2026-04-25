"""배포 파이프라인 — 5단계 배포 로직 (SSH 원격 배포)"""
import asyncio
import json
import re
import shlex
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import redis
import requests

from app.config import settings
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
    env_vars: dict | None = None


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
    """docker run 명령어를 구성한다. 플래그 파일은 read-only 마운트."""
    container_name = f"cstrike-{team.team_code}-{_safe_service_slug(service.name)}"
    flag_path = f"{FLAG_BASE_DIR}/{container_name}/flag.txt"
    host_port = service.container_port

    env_args = ""
    if service.env_vars:
        for k, v in service.env_vars.items():
            env_args += f" -e {shlex.quote(f'{k}={v}')}"

    quoted_name = shlex.quote(container_name)
    quoted_flag_path = shlex.quote(flag_path)
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
        f" -p {host_port}:{service.container_port}"
        f" -v {quoted_flag_path}:/flag.txt:ro"
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
    container_name = f"cstrike-{team.team_code}-{_safe_service_slug(service.name)}"
    host_port = service.container_port
    flag_dir = f"{FLAG_BASE_DIR}/{container_name}"

    with SSHExecutor(team.gateway_ip, team.ssh_port, team.ssh_user, team.ssh_password) as ssh:
        ssh.exec(f"docker rm -f {container_name} 2>/dev/null || true")
        ssh.exec(f"mkdir -p {flag_dir} && touch {flag_dir}/flag.txt")
        run_cmd = build_run_command(service, team)
        result = ssh.exec(run_cmd)
        if not result.success:
            raise RuntimeError(f"docker run 실패: {result.stderr.strip()}")
        container_id = result.stdout.strip()[:12]

    _update_team_service(team.team_id, service.service_id, {
        "host_ip": team.gateway_ip,
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
        container_name = f"cstrike-{team.team_code}-{_safe_service_slug(service.name)}"
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
                if service.health_check_endpoint:
                    hc_cmd = (
                        f"curl -sf -o /dev/null -w '%{{http_code}}'"
                        f" http://localhost:{service.container_port}{service.health_check_endpoint}"
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
