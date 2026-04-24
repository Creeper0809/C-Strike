"""실시간 이벤트 WebSocket 엔드포인트."""

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from jose import JWTError

from app.utils.security import decode_access_token
from app.redis_client import get_redis

router = APIRouter(tags=["WebSocket"])

# 연결된 클라이언트 관리
_connections: set[WebSocket] = set()


@router.websocket("/events")
async def ws_events(ws: WebSocket, token: str = Query(...)):
    """JWT 인증 후 ops:events 채널의 실시간 이벤트를 전달한다."""

    # 1. JWT 검증
    try:
        payload = decode_access_token(token)
        operator_id = payload.get("sub")
        if not operator_id:
            await ws.close(code=1008, reason="유효하지 않은 토큰")
            return
    except JWTError:
        await ws.close(code=1008, reason="토큰 검증 실패")
        return

    # 2. 연결 수락
    await ws.accept()
    _connections.add(ws)

    try:
        # 3. Redis 구독 루프
        redis = await get_redis()
        pubsub = redis.pubsub()
        await pubsub.subscribe("ops:events")

        async def listen_redis():
            """Redis Pub/Sub 메시지를 수신하여 WebSocket으로 전달한다."""
            async for message in pubsub.listen():
                if message["type"] == "message":
                    await ws.send_text(message["data"])

        async def listen_ws():
            """클라이언트 메시지를 대기하며 하트비트를 유지한다."""
            while True:
                try:
                    await asyncio.wait_for(ws.receive_text(), timeout=60)
                except asyncio.TimeoutError:
                    # 하트비트 ping
                    await ws.send_json({"type": "ping"})

        # 두 루프를 동시 실행
        await asyncio.gather(listen_redis(), listen_ws())

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _connections.discard(ws)
        await pubsub.unsubscribe("ops:events")
        await pubsub.close()
