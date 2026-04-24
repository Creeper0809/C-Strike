from fastapi import APIRouter
import docker

router = APIRouter()


@router.get("/health")
async def health_check():
    """deploy-service 헬스체크 — Docker 연결 + MinIO 연결 확인"""
    checks = {"docker": False, "minio": False}

    # Docker 연결 확인
    try:
        client = docker.from_env()
        client.ping()
        checks["docker"] = True
    except Exception:
        pass

    # MinIO 연결 확인
    try:
        from app.minio_client import get_minio_client
        mc = get_minio_client()
        mc.list_buckets()
        checks["minio"] = True
    except Exception:
        pass

    all_ok = all(checks.values())
    return {
        "status": "ok" if all_ok else "degraded",
        "checks": checks,
    }
