"""Docker 이미지 빌드 및 검증 로직"""
import asyncio
import json
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import docker
import redis
import requests

from app.config import settings
from app.minio_client import download_build_context, create_build_tar, save_build_log


def _find_dockerfile_root(context_dir: str) -> str | None:
    """빌드 컨텍스트에서 Dockerfile을 재귀 탐색하여 그 **디렉토리 경로**를 반환한다.

    사용자가 ZIP 업로드 시 `MyProject/Dockerfile` 구조로 올리면 tar 루트에 Dockerfile이 없어
    Docker SDK가 "Cannot locate specified Dockerfile: Dockerfile" 에러를 뱉는다.
    이 함수는 가장 얕은 깊이의 Dockerfile을 찾아 그 디렉토리를 새 빌드 루트로 사용한다.

    우선순위:
      1) context_dir 루트에 Dockerfile 있음 → context_dir 반환
      2) 하위 탐색 중 가장 얕은 깊이의 Dockerfile → 해당 디렉토리 반환
      3) 없음 → None
    """
    root_dockerfile = os.path.join(context_dir, "Dockerfile")
    if os.path.isfile(root_dockerfile):
        return context_dir

    best_depth = None
    best_root: str | None = None
    for current_root, _dirs, files in os.walk(context_dir):
        if "Dockerfile" in files:
            depth = current_root.replace(context_dir, "", 1).count(os.sep)
            if best_depth is None or depth < best_depth:
                best_depth = depth
                best_root = current_root
    return best_root

_executor = ThreadPoolExecutor(max_workers=4)


# Task 3: 헬스체크 엔드포인트 자동 감지 후보 경로.
# CTF 취약 서비스에서 가장 흔한 순서로 배치.
HEALTH_PROBE_CANDIDATES: tuple[str, ...] = (
    "/healthz",
    "/health",
    "/api/health",
    "/api/v1/health",
    "/ping",
    "/status",
    "/ready",
    "/alive",
    "/_health",
    "/heartbeat",
    "/livez",
    "/readyz",
    "/",
)


def probe_health_endpoints(host: str, port: int, timeout_per_path: float = 2.0) -> str | None:
    """테스트 컨테이너에 후보 경로를 순차 GET하여 2xx 반환하는 첫 경로를 채택한다.

    Args:
        host: 컨테이너 호스트 (보통 "localhost").
        port: 호스트 측 바인딩 포트.
        timeout_per_path: 경로당 HTTP 타임아웃(초).

    Returns:
        첫 2xx 응답 경로, 모두 실패하면 None.
    """
    for path in HEALTH_PROBE_CANDIDATES:
        url = f"http://{host}:{port}{path}"
        try:
            resp = requests.get(url, timeout=timeout_per_path, verify=False)
        except requests.RequestException:
            continue
        if 200 <= resp.status_code < 300:
            return path
    return None


def _get_docker_client() -> docker.DockerClient:
    return docker.from_env()


def _get_redis_client() -> redis.Redis:
    return redis.from_url(settings.REDIS_URL)


def _build_image_sync(service_id: str) -> dict:
    """동기 빌드 — ThreadPoolExecutor에서 실행된다."""
    docker_client = _get_docker_client()
    redis_client = _get_redis_client()
    image_tag = f"cstrike-vuln-{service_id}:latest"
    build_log_lines: list[str] = []

    def publish_progress(stage: str, message: str):
        payload = json.dumps({
            "service_id": service_id,
            "stage": stage,
            "message": message,
            "timestamp": time.time(),
        })
        redis_client.publish("deploy:build:progress", payload)

    try:
        # 1) MinIO에서 빌드 컨텍스트 다운로드
        publish_progress("download", "빌드 컨텍스트 다운로드 시작")
        with tempfile.TemporaryDirectory() as tmp_dir:
            download_build_context(service_id, tmp_dir)
            publish_progress("download", "빌드 컨텍스트 다운로드 완료")

            # 2) Dockerfile 위치 탐색 (업로드된 zip/폴더가 하위 경로에 Dockerfile을 둔 경우 대응)
            build_root = _find_dockerfile_root(tmp_dir)
            if build_root is None:
                raise FileNotFoundError(
                    "빌드 컨텍스트에 Dockerfile이 없습니다. "
                    "업로드한 파일에 'Dockerfile'이라는 정확한 이름의 파일이 포함되어야 합니다."
                )
            if build_root != tmp_dir:
                rel = os.path.relpath(build_root, tmp_dir)
                publish_progress("prepare", f"Dockerfile을 '{rel}/'에서 발견, 해당 경로를 빌드 루트로 사용")

            # 3) tar 아카이브 생성 (Dockerfile이 있는 디렉토리 기준)
            publish_progress("prepare", "빌드 컨텍스트 tar 생성")
            tar_stream = create_build_tar(build_root)

            # 4) Docker 이미지 빌드 — dockerfile 옵션 명시 (CTFd 패턴)
            publish_progress("build", "Docker 이미지 빌드 시작")
            image, build_logs = docker_client.images.build(
                fileobj=tar_stream,
                custom_context=True,
                dockerfile="Dockerfile",
                tag=image_tag,
                rm=True,
                timeout=settings.BUILD_TIMEOUT_SECONDS,
            )

            for chunk in build_logs:
                if "stream" in chunk:
                    line = chunk["stream"].strip()
                    if line:
                        build_log_lines.append(line)
                elif "error" in chunk:
                    build_log_lines.append(f"ERROR: {chunk['error']}")

        publish_progress("build", "Docker 이미지 빌드 완료")

        # Task 3: 빌드 성공 직후 자동 감지 probing.
        # 이미지 메타데이터에서 EXPOSE 포트 추출 → 테스트 컨테이너로 probing.
        detected_health_endpoint: str | None = None
        try:
            exposed = image.attrs.get("Config", {}).get("ExposedPorts") or {}
            if exposed:
                first_port = int(next(iter(exposed)).split("/")[0])
                validation = _validate_image_sync(image_tag, first_port, None)
                detected_health_endpoint = validation.get("detected_health_endpoint")
        except Exception as probe_err:
            publish_progress("probe", f"헬스체크 자동 감지 생략: {probe_err}")

        # 4) 완료 이벤트 발행 (detected_health_endpoint 포함)
        done_payload = json.dumps({
            "service_id": service_id,
            "status": "success",
            "docker_image": image_tag,
            "image_id": image.id,
            "detected_health_endpoint": detected_health_endpoint,
            "timestamp": time.time(),
        })
        redis_client.publish("deploy:build:done", done_payload)

        # 5) 빌드 로그 MinIO 저장
        log_content = "\n".join(build_log_lines)
        save_build_log(service_id, log_content)

        return {
            "service_id": service_id,
            "build_status": "success",
            "docker_image": image_tag,
            "detected_health_endpoint": detected_health_endpoint,
            "message": "빌드 완료",
        }

    except Exception as e:
        error_msg = str(e)
        build_log_lines.append(f"빌드 실패: {error_msg}")

        # 실패 이벤트 발행
        done_payload = json.dumps({
            "service_id": service_id,
            "status": "failed",
            "error": error_msg,
            "timestamp": time.time(),
        })
        redis_client.publish("deploy:build:done", done_payload)

        # 실패 로그도 MinIO 저장
        log_content = "\n".join(build_log_lines)
        try:
            save_build_log(service_id, log_content)
        except Exception:
            pass

        return {
            "service_id": service_id,
            "build_status": "failed",
            "docker_image": None,
            "message": error_msg,
        }
    finally:
        redis_client.close()


async def build_image(service_id: str) -> dict:
    """비동기 래퍼 — BackgroundTasks에서 호출된다."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, _build_image_sync, service_id)


def _validate_image_sync(
    docker_image: str,
    container_port: int,
    health_endpoint: str | None,
) -> dict:
    """동기 이미지 검증 — 테스트 컨테이너를 생성하여 헬스체크한다."""
    docker_client = _get_docker_client()
    test_container = None

    try:
        # 1) 이미지 존재 확인, 없으면 pull
        try:
            image = docker_client.images.get(docker_image)
        except docker.errors.ImageNotFound:
            image = docker_client.images.pull(docker_image)

        # 2) 테스트 컨테이너 생성 (랜덤 호스트 포트 바인딩)
        test_container = docker_client.containers.run(
            docker_image,
            detach=True,
            ports={f"{container_port}/tcp": None},
            labels={"cstrike-validate": "true"},
            name=f"cstrike-validate-{int(time.time())}",
        )

        # 3) 컨테이너 running 상태 대기 (최대 30초)
        elapsed = 0.0
        while elapsed < 30.0:
            test_container.reload()
            if test_container.status == "running":
                break
            time.sleep(1.0)
            elapsed += 1.0

        if test_container.status != "running":
            return {
                "valid": False,
                "image_id": image.id,
                "image_size_mb": round(image.attrs["Size"] / (1024 * 1024), 2),
                "error": f"컨테이너가 running 상태에 도달하지 못했습니다 (상태: {test_container.status})",
                "detected_health_endpoint": None,
            }

        # 4) 포트 매핑 확인
        test_container.reload()
        port_bindings = test_container.attrs["NetworkSettings"]["Ports"]
        port_key = f"{container_port}/tcp"
        if not port_bindings or port_key not in port_bindings or not port_bindings[port_key]:
            return {
                "valid": False,
                "image_id": image.id,
                "image_size_mb": round(image.attrs["Size"] / (1024 * 1024), 2),
                "error": "포트 바인딩을 확인할 수 없습니다",
                "detected_health_endpoint": None,
            }

        host_port = int(port_bindings[port_key][0]["HostPort"])

        # 5) HTTP 헬스체크 또는 자동 감지 probing (Task 3)
        detected_health_endpoint: str | None = None
        if health_endpoint:
            url = f"http://localhost:{host_port}{health_endpoint}"
            healthy = False
            for attempt in range(3):
                try:
                    resp = requests.get(url, timeout=10, verify=False)
                    if resp.status_code < 500:
                        healthy = True
                        break
                except requests.RequestException:
                    pass
                if attempt < 2:
                    time.sleep(5.0)

            if not healthy:
                return {
                    "valid": False,
                    "image_id": image.id,
                    "image_size_mb": round(image.attrs["Size"] / (1024 * 1024), 2),
                    "error": f"헬스체크 실패: {url}",
                    "detected_health_endpoint": None,
                }
        else:
            # 빈 값이면 후보 경로 순차 probing (Task 3)
            detected_health_endpoint = probe_health_endpoints("localhost", host_port)

        image_size_mb = round(image.attrs["Size"] / (1024 * 1024), 2)
        return {
            "valid": True,
            "image_id": image.id,
            "image_size_mb": image_size_mb,
            "error": None,
            "detected_health_endpoint": detected_health_endpoint,
        }

    except Exception as e:
        return {
            "valid": False,
            "image_id": None,
            "image_size_mb": None,
            "error": str(e),
            "detected_health_endpoint": None,
        }
    finally:
        # 테스트 컨테이너 정리
        if test_container is not None:
            try:
                test_container.stop(timeout=5)
            except Exception:
                pass
            try:
                test_container.remove(force=True)
            except Exception:
                pass


async def validate_image(
    docker_image: str,
    container_port: int,
    health_endpoint: str | None = None,
) -> dict:
    """비동기 래퍼 — 이미지 검증."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _executor, _validate_image_sync, docker_image, container_port, health_endpoint
    )
