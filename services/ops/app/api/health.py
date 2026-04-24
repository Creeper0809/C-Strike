"""헬스체크 라우터 — DB 및 Redis 연결 상태 확인."""

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.redis_client import get_redis

router = APIRouter(tags=["헬스체크"])


@router.get("/health")
async def health_check(db: AsyncSession = Depends(get_db)):
    """DB와 Redis 연결 상태를 확인하고 결과를 반환한다."""
    status_result = {"status": "ok", "db": "unknown", "redis": "unknown"}

    # DB 연결 확인
    try:
        await db.execute(text("SELECT 1"))
        status_result["db"] = "connected"
    except Exception as e:
        status_result["db"] = f"error: {e}"
        status_result["status"] = "degraded"

    # Redis 연결 확인
    try:
        redis = await get_redis()
        await redis.ping()
        status_result["redis"] = "connected"
    except Exception as e:
        status_result["redis"] = f"error: {e}"
        status_result["status"] = "degraded"

    return status_result
