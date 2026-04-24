"""빌드 관련 API 엔드포인트"""
from fastapi import APIRouter
from pydantic import BaseModel

from app.builder import build_image, validate_image

router = APIRouter(prefix="/build", tags=["build"])


class BuildResponse(BaseModel):
    service_id: str
    build_status: str                    # building | success | failed
    docker_image: str | None = None
    detected_health_endpoint: str | None = None
    message: str = ""


class ValidateRequest(BaseModel):
    docker_image: str
    container_port: int
    health_check_endpoint: str | None = None


class ValidateResponse(BaseModel):
    valid: bool
    image_id: str | None = None
    image_size_mb: float | None = None
    error: str | None = None
    detected_health_endpoint: str | None = None


@router.post("/{service_id}", response_model=BuildResponse)
async def start_build(service_id: str):
    """Docker 이미지 빌드 실행 (동기, 완료까지 대기).

    CTFd env-orchestrator와 동일한 동기식 응답 패턴.
    응답 시점에 build_status는 최종 상태(success 또는 failed)로 확정되어 있다.
    호출자는 Redis pub/sub 콜백에 의존하지 않고 응답 바디만 신뢰하면 된다.
    ops-backend가 이 응답을 받아 DB를 즉시 업데이트하므로 무한 "building" 상태가 사라진다.
    """
    result = await build_image(service_id)
    return BuildResponse(
        service_id=service_id,
        build_status=result.get("build_status", "failed"),
        docker_image=result.get("docker_image"),
        detected_health_endpoint=result.get("detected_health_endpoint"),
        message=result.get("message", ""),
    )


@router.get("/{service_id}/log")
async def get_build_log(service_id: str):
    """MinIO에서 최신 빌드 로그 조회."""
    from app.minio_client import get_minio_client
    from app.config import settings

    mc = get_minio_client()
    prefix = f"build-logs/{service_id}/"
    objects = list(mc.list_objects(settings.MINIO_BUCKET, prefix=prefix, recursive=True))
    if not objects:
        return {"service_id": service_id, "log": None, "message": "빌드 로그가 없습니다"}

    latest = sorted(objects, key=lambda o: o.last_modified, reverse=True)[0]
    response = mc.get_object(settings.MINIO_BUCKET, latest.object_name)
    log_content = response.read().decode("utf-8")
    response.close()
    response.release_conn()
    return {"service_id": service_id, "log": log_content}


@router.post("/validate/{service_id}", response_model=ValidateResponse)
async def validate_service_image(service_id: str, req: ValidateRequest):
    """Docker 이미지 pull + 테스트 컨테이너 검증."""
    result = await validate_image(
        req.docker_image, req.container_port, req.health_check_endpoint
    )
    return ValidateResponse(**result)
