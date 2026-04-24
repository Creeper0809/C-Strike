"""실시간 이벤트 발행 유틸리티."""

import json
from datetime import datetime, timezone

from app.redis_client import get_redis


async def publish_event(event_type: str, data: dict) -> None:
    """ops:events 채널에 이벤트를 발행한다.

    Redis 미연결 시에도 에러를 발생시키지 않는다 (try/except).
    """
    try:
        redis = await get_redis()
        message = json.dumps(
            {
                "type": event_type,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "data": data,
            },
            ensure_ascii=False,
        )
        await redis.publish("ops:events", message)
    except Exception:
        pass  # Redis 미연결 시 무시 — WebSocket은 폴링 폴백으로 대응
