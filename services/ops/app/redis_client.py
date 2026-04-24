"""Redis 비동기 클라이언트 설정."""

import redis.asyncio as aioredis

from app.config import settings

# Redis 연결 풀
_redis_pool: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    """Redis 연결을 반환한다. 최초 호출 시 연결 풀을 생성한다."""
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = aioredis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
        )
    return _redis_pool
