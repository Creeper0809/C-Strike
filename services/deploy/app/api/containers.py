"""컨테이너 관리 API 엔드포인트"""
from fastapi import APIRouter, Query

from app.container_manager import (
    list_all_service_containers,
    list_team_containers,
    get_container_logs,
    stop_container,
    start_container,
    remove_container,
    remove_service_containers,
    reset_container,
)

router = APIRouter(prefix="/containers", tags=["containers"])


@router.delete("/service/{service_id}")
async def remove_all_for_service(service_id: str):
    """특정 서비스에 속한 모든 팀 컨테이너 + 빌드 이미지 일괄 제거."""
    return remove_service_containers(service_id)


@router.get("")
async def get_all_containers():
    return list_all_service_containers()


@router.get("/{team_id}")
async def get_team_containers(team_id: str):
    return list_team_containers(team_id)


@router.get("/{container_id}/logs")
async def get_logs(container_id: str, tail: int = Query(200, ge=1, le=5000)):
    return {"container_id": container_id, "logs": get_container_logs(container_id, tail)}


@router.post("/{container_id}/stop")
async def stop(container_id: str):
    return stop_container(container_id)


@router.post("/{container_id}/start")
async def start(container_id: str):
    return start_container(container_id)


@router.delete("/{container_id}")
async def remove(container_id: str):
    return remove_container(container_id)


@router.post("/reset/{team_id}/{service_id}")
async def reset(team_id: str, service_id: str):
    return reset_container(team_id, service_id, {})
