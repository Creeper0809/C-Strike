"""Redis Pub/Sub 이벤트 발행/구독 모듈.

채점 엔진의 모든 외부 통신(라운드 알림, 비상 통제 수신)을 담당한다.
Redis 연결이 끊겨도 채점 로직 자체는 계속 동작하며,
발행 실패 이벤트는 메모리 버퍼에 보관 후 재연결 시 flush 한다.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from typing import Any, Callable, Coroutine

import redis.asyncio as aioredis

from .config import settings

logger = logging.getLogger("scoring.events")

# ── 채점 엔진이 발행하는 채널 ──
CH_ROUND_START = "scoring:round:start"
CH_ROUND_COMPLETE = "scoring:round:complete"
CH_FLAG_CAPTURED = "scoring:flag:captured"
CH_SLA_DOWN = "scoring:sla:down"
CH_VULNPACK_RELEASED = "scoring:vulnpack:released"

# ── 채점 엔진이 구독하는 채널 ──
CH_EMERGENCY_HALT = "emergency:halt"
CH_EMERGENCY_RESUME = "emergency:resume"
CH_CONFIG_INTERVAL = "config:scoring_interval"
CH_COMPETITION_START = "competition:start"
CH_COMPETITION_END = "competition:end"

SUBSCRIBE_CHANNELS = [
    CH_EMERGENCY_HALT,
    CH_EMERGENCY_RESUME,
    CH_CONFIG_INTERVAL,
    CH_COMPETITION_START,
    CH_COMPETITION_END,
]

# 이벤트 핸들러 타입: async def handler(channel: str, data: dict) -> None
EventHandler = Callable[[str, dict], Coroutine[Any, Any, None]]


class EventBus:
    """Redis 기반 이벤트 발행/구독 관리자.

    - 발행 실패 시 내부 버퍼에 저장, 재연결 후 flush
    - 구독 채널의 메시지를 등록된 핸들러로 디스패치
    """

    def __init__(self) -> None:
        self._redis: aioredis.Redis | None = None
        self._pubsub: aioredis.client.PubSub | None = None
        self._buffer: deque[tuple[str, str]] = deque(maxlen=settings.REDIS_EVENT_BUFFER_MAX)
        self._handlers: dict[str, list[EventHandler]] = {}
        self._listener_task: asyncio.Task | None = None
        self._running = False

    # ── 연결 관리 ──

    async def connect(self) -> None:
        """Redis 연결을 수립한다."""
        try:
            self._redis = aioredis.from_url(
                settings.REDIS_URL,
                decode_responses=True,
            )
            await self._redis.ping()
            logger.info("Redis 연결 성공: %s", settings.REDIS_URL)
            # 버퍼에 쌓인 이벤트 flush
            await self._flush_buffer()
        except Exception as exc:
            logger.error("Redis 연결 실패: %s", exc)
            self._redis = None

    async def disconnect(self) -> None:
        """Redis 연결을 안전하게 종료한다."""
        self._running = False
        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
        if self._pubsub:
            await self._pubsub.unsubscribe()
            await self._pubsub.close()
            self._pubsub = None
        if self._redis:
            await self._redis.close()
            self._redis = None
        logger.info("Redis 연결 종료 완료")

    # ── 발행 ──

    async def publish(self, channel: str, data: dict) -> bool:
        """이벤트를 발행한다. 실패 시 버퍼에 저장하고 False를 반환한다."""
        payload = json.dumps(data, ensure_ascii=False, default=str)
        if self._redis is None:
            self._buffer.append((channel, payload))
            logger.warning("Redis 미연결 — 이벤트 버퍼링: %s", channel)
            return False
        try:
            await self._redis.publish(channel, payload)
            logger.debug("이벤트 발행: %s → %s", channel, payload)
            return True
        except Exception as exc:
            logger.error("이벤트 발행 실패 (%s): %s", channel, exc)
            self._buffer.append((channel, payload))
            return False

    async def _flush_buffer(self) -> None:
        """버퍼에 쌓인 이벤트를 순서대로 발행한다."""
        if not self._redis or not self._buffer:
            return
        flushed = 0
        while self._buffer:
            channel, payload = self._buffer[0]
            try:
                await self._redis.publish(channel, payload)
                self._buffer.popleft()
                flushed += 1
            except Exception:
                break
        if flushed:
            logger.info("버퍼 이벤트 %d건 flush 완료", flushed)

    # ── 구독 ──

    def on(self, channel: str, handler: EventHandler) -> None:
        """특정 채널에 이벤트 핸들러를 등록한다."""
        self._handlers.setdefault(channel, []).append(handler)

    async def start_listening(self) -> None:
        """구독 리스너를 시작한다. 백그라운드 태스크로 실행된다."""
        if self._redis is None:
            logger.error("Redis 미연결 — 구독 시작 불가")
            return
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(*SUBSCRIBE_CHANNELS)
        self._running = True
        self._listener_task = asyncio.create_task(self._listen_loop())
        logger.info("Redis 구독 시작: %s", SUBSCRIBE_CHANNELS)

    async def _listen_loop(self) -> None:
        """구독 메시지를 수신하고 핸들러로 디스패치하는 루프."""
        while self._running:
            try:
                message = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if message is None:
                    await asyncio.sleep(0.1)
                    continue
                channel = message.get("channel", "")
                raw_data = message.get("data", "")
                if not isinstance(raw_data, str):
                    continue
                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError:
                    logger.warning("잘못된 JSON 수신 (%s): %s", channel, raw_data)
                    continue
                handlers = self._handlers.get(channel, [])
                for handler in handlers:
                    try:
                        await handler(channel, data)
                    except Exception as exc:
                        logger.error(
                            "이벤트 핸들러 오류 (%s): %s", channel, exc, exc_info=True
                        )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("구독 루프 오류: %s", exc, exc_info=True)
                await asyncio.sleep(1.0)
        logger.info("Redis 구독 루프 종료")
