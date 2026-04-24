"""컨테이너 CRUD 관리 — docker-py 기반"""
import docker

from app.port_allocator import release_ports_from_container_attrs


def _get_docker_client() -> docker.DockerClient:
    return docker.from_env()


def list_all_service_containers() -> list[dict]:
    """cstrike-service=true 라벨이 있는 모든 컨테이너 목록을 반환한다."""
    client = _get_docker_client()
    containers = client.containers.list(
        all=True, filters={"label": "cstrike-service=true"}
    )

    result = []
    for c in containers:
        labels = c.labels or {}
        result.append({
            "container_id": c.id,
            "name": c.name,
            "status": c.status,
            "team_id": labels.get("cstrike-team-id", ""),
            "team_code": labels.get("cstrike-team-code", ""),
            "service_id": labels.get("cstrike-service-id", ""),
            "service_name": labels.get("cstrike-service-name", ""),
            "image": c.image.tags[0] if c.image.tags else str(c.image.id),
            "created": c.attrs.get("Created", ""),
        })

    return result


def list_team_containers(team_id: str) -> list[dict]:
    """특정 팀의 컨테이너 목록을 반환한다."""
    all_containers = list_all_service_containers()
    return [c for c in all_containers if c["team_id"] == team_id]


def get_container_logs(container_id: str, tail: int = 200) -> str:
    """컨테이너 로그를 반환한다."""
    client = _get_docker_client()
    try:
        container = client.containers.get(container_id)
        logs = container.logs(tail=tail, timestamps=True)
        return logs.decode("utf-8", errors="replace")
    except docker.errors.NotFound:
        return f"컨테이너를 찾을 수 없습니다: {container_id}"
    except Exception as e:
        return f"로그 조회 오류: {e}"


def stop_container(container_id: str) -> dict:
    """컨테이너를 중지한다."""
    client = _get_docker_client()
    try:
        container = client.containers.get(container_id)
        container.stop(timeout=10)
        return {"container_id": container_id, "status": "stopped", "message": "컨테이너가 중지되었습니다"}
    except docker.errors.NotFound:
        return {"container_id": container_id, "status": "error", "message": "컨테이너를 찾을 수 없습니다"}
    except Exception as e:
        return {"container_id": container_id, "status": "error", "message": str(e)}


def start_container(container_id: str) -> dict:
    """컨테이너를 시작한다."""
    client = _get_docker_client()
    try:
        container = client.containers.get(container_id)
        container.start()
        return {"container_id": container_id, "status": "started", "message": "컨테이너가 시작되었습니다"}
    except docker.errors.NotFound:
        return {"container_id": container_id, "status": "error", "message": "컨테이너를 찾을 수 없습니다"}
    except Exception as e:
        return {"container_id": container_id, "status": "error", "message": str(e)}


def remove_container(container_id: str) -> dict:
    """컨테이너를 중지/삭제하고 호스트 포트를 Redis SET에서 쿨다운 해제한다."""
    client = _get_docker_client()
    try:
        container = client.containers.get(container_id)
        try:
            container.reload()
            release_ports_from_container_attrs(container.attrs)
        except Exception:
            pass
        try:
            container.stop(timeout=10)
        except Exception:
            pass
        container.remove(force=True)
        return {"container_id": container_id, "status": "removed", "message": "컨테이너가 삭제되었습니다"}
    except docker.errors.NotFound:
        return {"container_id": container_id, "status": "error", "message": "컨테이너를 찾을 수 없습니다"}
    except Exception as e:
        return {"container_id": container_id, "status": "error", "message": str(e)}


def remove_service_containers(service_id: str) -> dict:
    """특정 service_id 라벨이 붙은 **모든 팀**의 컨테이너를 일괄 정지/삭제한다.

    서비스 삭제 시 호출. 각 컨테이너의 호스트 포트도 Redis SET에서 해제한다.
    추가로 Dockerfile 모드로 빌드된 `cstrike-vuln-{service_id}:latest` 이미지도 제거.
    """
    client = _get_docker_client()
    containers = client.containers.list(
        all=True,
        filters={
            "label": [
                "cstrike-service=true",
                f"cstrike-service-id={service_id}",
            ]
        },
    )

    removed_containers = []
    for c in containers:
        try:
            try:
                c.reload()
                release_ports_from_container_attrs(c.attrs)
            except Exception:
                pass
            try:
                c.stop(timeout=10)
            except Exception:
                pass
            c.remove(force=True)
            removed_containers.append(c.name)
        except Exception as e:
            removed_containers.append(f"{c.name} (에러: {e})")

    image_removed = False
    image_error: str | None = None
    image_tag = f"cstrike-vuln-{service_id}:latest"
    try:
        client.images.remove(image_tag, force=True)
        image_removed = True
    except docker.errors.ImageNotFound:
        image_error = "이미지 없음 (이미 삭제되었거나 이미지 모드)"
    except Exception as e:
        image_error = str(e)

    return {
        "service_id": service_id,
        "removed_containers": removed_containers,
        "container_count": len(removed_containers),
        "image_removed": image_removed,
        "image_tag": image_tag,
        "image_error": image_error,
    }


def reset_container(team_id: str, service_id: str, service_info: dict) -> dict:
    """팀/서비스 조합에 해당하는 컨테이너를 찾아 삭제한다."""
    client = _get_docker_client()
    containers = client.containers.list(
        all=True,
        filters={
            "label": [
                "cstrike-service=true",
                f"cstrike-team-id={team_id}",
                f"cstrike-service-id={service_id}",
            ]
        },
    )

    removed = []
    for c in containers:
        try:
            try:
                c.reload()
                release_ports_from_container_attrs(c.attrs)
            except Exception:
                pass
            try:
                c.stop(timeout=10)
            except Exception:
                pass
            c.remove(force=True)
            removed.append(c.name)
        except Exception as e:
            removed.append(f"{c.name} (에러: {e})")

    if not removed:
        return {
            "team_id": team_id,
            "service_id": service_id,
            "status": "not_found",
            "message": "해당 컨테이너를 찾을 수 없습니다",
        }

    return {
        "team_id": team_id,
        "service_id": service_id,
        "status": "reset",
        "removed": removed,
        "message": f"{len(removed)}개 컨테이너가 리셋되었습니다",
    }
