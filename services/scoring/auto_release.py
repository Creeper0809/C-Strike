"""취약점팩 자동 공개 체커.

scoring-engine의 메인 루프에서 주기적으로 호출되며, 다음 조건을 만족하는
취약점팩을 ops-backend의 내부 엔드포인트로 공개 요청한다.

공개 조건:
    pack.status == 'scheduled'
    AND pack.competition_id == running_competition.id
    AND running_competition.actual_start_at + pack.scheduled_offset_minutes * 60 <= now(UTC)
    AND running_competition.status != 'paused'  (이 체크는 check() 내부)

실패 격리:
    개별 팩 공개 요청 실패가 다음 팩 처리를 막지 않는다.
    ops-backend 연결 실패는 로그만 남기고 다음 폴링 주기에 재시도된다.
    멱등성: 이미 released 상태인 팩은 ops-backend가 400 반환 → 로그 warn + 무시.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import text

from .config import settings
from .database import async_session_factory
from .events import CH_VULNPACK_RELEASED, EventBus

logger = logging.getLogger("scoring.auto_release")


class AutoReleaseChecker:
    """취약점팩 자동 공개 체커 (scoring-engine 메인 루프가 5초 주기로 호출)."""

    def __init__(self, event_bus: EventBus | None = None) -> None:
        self._event_bus = event_bus
        self._ops_base = settings.OPS_BACKEND_URL.rstrip("/")
        self._internal_key = settings.OPS_INTERNAL_API_KEY
        self._http_timeout = 15.0

    # ── 공개 API ──

    async def check(
        self,
        competition_id: UUID,
        actual_start_at: datetime | None,
        competition_status: str,
    ) -> int:
        """한 번의 체크 사이클을 실행하고 공개한 팩 수를 반환한다.

        Args:
            competition_id: 현재 running 대회 ID
            actual_start_at: 대회 실제 시작 시각 (UTC, nullable)
            competition_status: "running" / "paused" / 기타
        """
        if competition_status == "paused":
            logger.debug("대회 paused 상태 — 자동 공개 건너뛰기")
            return 0

        if actual_start_at is None:
            logger.debug("actual_start_at이 NULL — 자동 공개 건너뛰기")
            return 0

        due_packs = await self._fetch_due_packs(competition_id, actual_start_at)
        if not due_packs:
            return 0

        logger.info(
            "자동 공개 대상 팩 %d개 발견 (competition_id=%s)",
            len(due_packs), competition_id,
        )

        released_count = 0
        for pack in due_packs:
            try:
                if await self._release_one(pack):
                    released_count += 1
            except Exception as exc:
                logger.error(
                    "팩 %s 자동 공개 중 예외: %s",
                    pack["id"], exc, exc_info=True,
                )

        return released_count

    # ── 내부 로직 ──

    async def _fetch_due_packs(
        self, competition_id: UUID, actual_start_at: datetime
    ) -> list[dict[str, Any]]:
        """시간 조건을 만족하는 scheduled 팩 목록을 조회한다."""
        now = datetime.now(timezone.utc)

        try:
            async with async_session_factory() as session:
                result = await session.execute(
                    text("""
                        SELECT
                            id,
                            pack_number,
                            scheduled_offset_minutes
                        FROM vulnpack_schedules
                        WHERE competition_id = :comp_id
                          AND status = 'scheduled'
                        ORDER BY scheduled_offset_minutes ASC, pack_number ASC
                    """),
                    {"comp_id": competition_id},
                )
                rows = result.fetchall()
        except Exception as exc:
            logger.warning("자동 공개 대상 조회 실패: %s", exc)
            return []

        due_packs: list[dict[str, Any]] = []
        for row in rows:
            offset = row.scheduled_offset_minutes or 0
            if self._is_due(actual_start_at, offset, now=now):
                due_packs.append({
                    "id": row.id,
                    "pack_number": row.pack_number,
                    "offset_minutes": offset,
                })

        return due_packs

    @staticmethod
    def _is_due(
        actual_start_at: datetime,
        offset_minutes: int,
        now: datetime | None = None,
    ) -> bool:
        """팩 공개 시점 도달 여부. 비교는 UTC 기준, naive datetime은 UTC로 해석."""
        if now is None:
            now = datetime.now(timezone.utc)

        start = actual_start_at
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)

        due_at_seconds = (now - start).total_seconds()
        required_seconds = offset_minutes * 60
        return due_at_seconds >= required_seconds

    async def _release_one(self, pack: dict[str, Any]) -> bool:
        """ops-backend의 auto-release 엔드포인트를 호출한다."""
        pack_id = pack["id"]
        pack_number = pack["pack_number"]
        url = f"{self._ops_base}/api/v1/internal/vulnpacks/{pack_id}/auto-release"

        try:
            async with httpx.AsyncClient(timeout=self._http_timeout, verify=False) as client:
                resp = await client.post(
                    url,
                    headers={"X-Internal-API-Key": self._internal_key},
                )
        except httpx.RequestError as exc:
            logger.warning("ops-backend 통신 실패 (pack=%s): %s", pack_id, exc)
            return False

        if resp.status_code == 200:
            logger.info("자동 공개 성공: pack_number=%d id=%s", pack_number, pack_id)
            await self._publish_released_event(pack_id, pack_number)
            return True
        elif resp.status_code == 400:
            logger.warning("팩 이미 released 상태 (pack=%s): %s", pack_id, resp.text)
            return False
        else:
            logger.error(
                "자동 공개 실패 (pack=%s, status=%d): %s",
                pack_id, resp.status_code, resp.text,
            )
            return False

    async def _publish_released_event(self, pack_id: Any, pack_number: int) -> None:
        """Redis 이벤트 발행 (Phase 15 디스코드 봇 확장 대비)."""
        if self._event_bus is None:
            return
        try:
            await self._event_bus.publish(CH_VULNPACK_RELEASED, {
                "pack_id": str(pack_id),
                "pack_number": pack_number,
                "released_at": datetime.now(timezone.utc).isoformat(),
                "trigger": "auto",
            })
        except Exception as exc:
            logger.warning("Redis 이벤트 발행 실패: %s", exc)
