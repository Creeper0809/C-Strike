"""디스코드 봇 관리 대시보드 API — 조회 전용.

C-가드 대시보드(`api/cguard.py`) 패턴을 그대로 모방한다.
모든 엔드포인트는 `GET` 이며 운영자 인증을 요구한다.
절대 액션(전송/삭제 등) API 는 이곳에 두지 않는다.

데이터 소스:
  - cstrike.ops_audit_logs         — 감사 로그 (운영자 조작 이력)
  - cstrike.scheduled_announcements — 전체 공지 예약
  - cstrike.team_announcements      — 팀별 공지
  - cstrike.team_hints              — 팀별 힌트/자료
  - cstrike.relay_events            — 운영포털 → 봇 릴레이 원장
  - cstrike.relay_dispatch_history  — 릴레이 디스패치 이력
  - cstrike.cguard_user_status      — C-가드 상태 미러
"""

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_operator
from app.database import get_db
from app.external import discord_client
from app.models.operator import Operator
from app.schemas.discord_bot_admin import (
    DiscordBotBroadcastItem,
    DiscordBotBroadcastListResponse,
    DiscordBotCGuardEventItem,
    DiscordBotCGuardEventListResponse,
    DiscordBotEventItem,
    DiscordBotEventListResponse,
    DiscordBotRelayItem,
    DiscordBotRelayListResponse,
    DiscordBotSummaryResponse,
)

router = APIRouter(tags=["디스코드 봇 관리"])

logger = logging.getLogger(__name__)


# ── 내부 헬퍼 ─────────────────────────────────────────────────


async def _safe_scalar(db: AsyncSession, query: str, params: dict | None = None) -> int:
    """COUNT 쿼리를 실행해 정수를 반환한다.

    예외 발생 시 0을 반환하고 로깅만 한다 (500 에러로 사용자에게 노출 금지).
    """
    try:
        result = await db.execute(text(query), params or {})
        value = result.scalar()
        return int(value) if value is not None else 0
    except Exception as exc:
        logger.warning("discord_bot_admin scalar 쿼리 실패: %s", exc)
        return 0


def _coerce_json(value: Any) -> dict | None:
    """DB 에서 받은 JSON 문자열/dict/None 을 dict | None 으로 정규화한다."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        except Exception:
            return {"raw": value}
    return None


def _authenticated_from_status(status: str | None) -> bool:
    """C-가드 status 값이 '정상'에 해당하는지 판정한다.

    C-가드 DDL 상 status 는 자유 문자열이므로 'ok' / 'active' / 'authenticated'
    계열만 True 로 본다 (대소문자 무시).
    """
    if not status:
        return False
    return status.lower() in {"ok", "active", "authenticated", "authorized"}


# ── 1. GET /summary ───────────────────────────────────────────


@router.get("/summary", response_model=DiscordBotSummaryResponse)
async def get_discord_bot_summary(
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """디스코드 봇 대시보드 상단의 요약 통계를 조회한다.

    - 봇 헬스체크는 `discord_client.health()` 결과로 결정한다.
    - 집계 쿼리 각각은 독립적으로 실패해도 전체 요약은 계속 내려준다.
    """
    from datetime import datetime, timezone
    import time

    # 1) 봇 헬스체크 + 지연 측정
    bot_status = "unknown"
    bot_latency_ms: int | None = None
    last_heartbeat_at: datetime | None = None
    try:
        t0 = time.monotonic()
        await discord_client.health()
        bot_latency_ms = int((time.monotonic() - t0) * 1000)
        last_heartbeat_at = datetime.now(timezone.utc)
        bot_status = "ok"
    except Exception as exc:
        logger.info("discord_bot 헬스체크 실패: %s", exc)
        bot_status = "down"

    # 2) 누적 집계 (4개)
    total_events = await _safe_scalar(
        db, "SELECT COUNT(*) FROM cstrike.ops_audit_logs"
    )
    scheduled_total = await _safe_scalar(db, "SELECT COUNT(*) FROM cstrike.scheduled_announcements")
    team_total = await _safe_scalar(db, "SELECT COUNT(*) FROM cstrike.team_announcements")
    hint_total = await _safe_scalar(db, "SELECT COUNT(*) FROM cstrike.team_hints")
    total_broadcasts = scheduled_total + team_total + hint_total
    total_relays = await _safe_scalar(db, "SELECT COUNT(*) FROM cstrike.relay_events")
    total_cguard_events = await _safe_scalar(db, "SELECT COUNT(*) FROM cstrike.cguard_user_status")

    # 3) 최근 24시간 집계
    recent_events = await _safe_scalar(
        db, "SELECT COUNT(*) FROM cstrike.ops_audit_logs WHERE created_at > now() - interval '24 hours'"
    )
    recent_scheduled = await _safe_scalar(
        db, "SELECT COUNT(*) FROM cstrike.scheduled_announcements WHERE created_at > now() - interval '24 hours'"
    )
    recent_team = await _safe_scalar(
        db, "SELECT COUNT(*) FROM cstrike.team_announcements WHERE created_at > now() - interval '24 hours'"
    )
    recent_hint = await _safe_scalar(
        db, "SELECT COUNT(*) FROM cstrike.team_hints WHERE created_at > now() - interval '24 hours'"
    )
    recent_broadcasts = recent_scheduled + recent_team + recent_hint
    recent_relays = await _safe_scalar(
        db, "SELECT COUNT(*) FROM cstrike.relay_events WHERE created_at > now() - interval '24 hours'"
    )
    recent_cguard = await _safe_scalar(
        db, "SELECT COUNT(*) FROM cstrike.cguard_user_status WHERE updated_at > now() - interval '24 hours'"
    )

    return DiscordBotSummaryResponse(
        bot_status=bot_status,
        bot_latency_ms=bot_latency_ms,
        last_heartbeat_at=last_heartbeat_at,
        total_events=total_events,
        total_broadcasts=total_broadcasts,
        total_relays=total_relays,
        total_cguard_events=total_cguard_events,
        recent_events_24h=recent_events,
        recent_broadcasts_24h=recent_broadcasts,
        recent_relays_24h=recent_relays,
        recent_cguard_events_24h=recent_cguard,
    )


# ── 2. GET /events ────────────────────────────────────────────


@router.get("/events", response_model=DiscordBotEventListResponse)
async def get_discord_bot_events(
    log_type: str | None = Query(None, description="target_type 필터 (예: team, ticket)"),
    event_key: str | None = Query(None, description="action 필터 (정확히 일치)"),
    team_id: str | None = Query(None, description="team_id(=target_id) 필터 (UUID)"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """운영 감사 로그(ops_audit_logs)를 디스코드 봇 이벤트 형식으로 조회한다.

    컬럼 매핑:
      log_type  ← target_type
      event_key ← action
      team_id   ← target_id
    ORDER BY created_at DESC.
    """
    offset = (page - 1) * size

    conditions = ["1=1"]
    params: dict = {"limit": size, "offset": offset}

    if log_type:
        conditions.append("a.target_type = :log_type")
        params["log_type"] = log_type
    if event_key:
        conditions.append("a.action = :event_key")
        params["event_key"] = event_key
    if team_id:
        conditions.append("a.target_id = :team_id")
        params["team_id"] = team_id

    where_clause = " AND ".join(conditions)

    try:
        result = await db.execute(
            text(f"""
                SELECT
                    a.id,
                    a.target_type AS log_type,
                    a.action       AS event_key,
                    a.actor_id,
                    a.target_id    AS team_id,
                    a.details,
                    a.created_at
                FROM cstrike.ops_audit_logs a
                WHERE {where_clause}
                ORDER BY a.created_at DESC
                OFFSET :offset
                LIMIT :limit
            """),
            params,
        )
        rows = result.fetchall()

        count_result = await db.execute(
            text(f"""
                SELECT COUNT(*) FROM cstrike.ops_audit_logs a
                WHERE {where_clause}
            """),
            params,
        )
        total = count_result.scalar() or 0
    except Exception as exc:
        logger.warning("discord_bot_admin /events 쿼리 실패: %s", exc)
        return DiscordBotEventListResponse(items=[], total=0, page=page, size=size)

    items = [
        DiscordBotEventItem(
            # ops_audit_logs.id 는 UUID 이므로 int 스키마 맞춤을 위해 해시 대신
            # 문자열 → hash() 사용이 아닌, 일련 번호를 별도 만들지 않고
            # 페이지 내 순번을 부여 (DB 원본 ID 는 details 로 노출).
            id=idx + 1 + offset,
            log_type=r.log_type,
            event_key=r.event_key,
            actor_id=str(r.actor_id) if r.actor_id is not None else None,
            team_id=str(r.team_id) if r.team_id is not None else None,
            details=(
                {"audit_id": str(r[0]), **(_coerce_json(r.details) or {})}
                if r.details is not None
                else {"audit_id": str(r[0])}
            ),
            created_at=r.created_at,
        )
        for idx, r in enumerate(rows)
    ]

    return DiscordBotEventListResponse(
        items=items, total=total, page=page, size=size
    )


# ── 3. GET /broadcasts ───────────────────────────────────────


@router.get("/broadcasts", response_model=DiscordBotBroadcastListResponse)
async def get_discord_bot_broadcasts(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """3개 공지 테이블을 UNION 하여 시간 역순으로 조회한다.

    - scheduled_announcements → kind='scheduled'
    - team_announcements      → kind='team'
    - team_hints              → kind='hint'
    공통 컬럼: id, kind, channel_id, title, content, scheduled_at, sent_at, created_at.
    """
    offset = (page - 1) * size

    union_sql = """
        SELECT id, 'scheduled' AS kind, channel_id, title,
               description AS content, scheduled_at, sent_at, created_at
        FROM cstrike.scheduled_announcements
        UNION ALL
        SELECT id, 'team' AS kind, channel_id, title,
               description AS content, scheduled_at, sent_at, created_at
        FROM cstrike.team_announcements
        UNION ALL
        SELECT id, 'hint' AS kind, channel_id, title,
               COALESCE(description, '') AS content, scheduled_at, sent_at, created_at
        FROM cstrike.team_hints
    """

    try:
        result = await db.execute(
            text(f"""
                SELECT * FROM (
                    {union_sql}
                ) u
                ORDER BY created_at DESC NULLS LAST
                OFFSET :offset
                LIMIT :limit
            """),
            {"offset": offset, "limit": size},
        )
        rows = result.fetchall()

        count_result = await db.execute(
            text(f"SELECT COUNT(*) FROM ({union_sql}) u")
        )
        total = count_result.scalar() or 0
    except Exception as exc:
        logger.warning("discord_bot_admin /broadcasts 쿼리 실패: %s", exc)
        return DiscordBotBroadcastListResponse(
            items=[], total=0, page=page, size=size
        )

    items = [
        DiscordBotBroadcastItem(
            id=int(r.id),
            kind=r.kind,
            channel_id=r.channel_id,
            title=r.title,
            content=r.content or "",
            scheduled_at=r.scheduled_at,
            sent_at=r.sent_at,
            created_at=r.created_at,
        )
        for r in rows
    ]

    return DiscordBotBroadcastListResponse(
        items=items, total=total, page=page, size=size
    )


# ── 4. GET /relays ────────────────────────────────────────────


@router.get("/relays", response_model=DiscordBotRelayListResponse)
async def get_discord_bot_relays(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """릴레이 이벤트를 조회한다.

    `relay_events`에 디스패치 이력을 붙여야 `sent_at` 을 알 수 있는데
    두 테이블 간 직접 FK 가 없으므로 discord_channel_id 가 일치하는
    가장 최근 디스패치의 sent_at 을 LATERAL LEFT JOIN 으로 가져온다.
    """
    offset = (page - 1) * size

    try:
        result = await db.execute(
            text("""
                SELECT
                    e.id,
                    e.event_type,
                    e.channel_id,
                    e.payload_json,
                    h.sent_at,
                    e.created_at
                FROM cstrike.relay_events e
                LEFT JOIN LATERAL (
                    SELECT sent_at
                    FROM cstrike.relay_dispatch_history d
                    WHERE d.discord_channel_id = e.channel_id
                      AND d.sent_at IS NOT NULL
                    ORDER BY d.sent_at DESC
                    LIMIT 1
                ) h ON TRUE
                ORDER BY e.created_at DESC
                OFFSET :offset
                LIMIT :limit
            """),
            {"offset": offset, "limit": size},
        )
        rows = result.fetchall()

        count_result = await db.execute(
            text("SELECT COUNT(*) FROM cstrike.relay_events")
        )
        total = count_result.scalar() or 0
    except Exception as exc:
        logger.warning("discord_bot_admin /relays 쿼리 실패: %s", exc)
        return DiscordBotRelayListResponse(
            items=[], total=0, page=page, size=size
        )

    items = [
        DiscordBotRelayItem(
            id=int(r.id),
            event_type=r.event_type,
            channel_id=r.channel_id,
            payload=_coerce_json(r.payload_json),
            sent_at=r.sent_at,
            created_at=r.created_at,
        )
        for r in rows
    ]

    return DiscordBotRelayListResponse(
        items=items, total=total, page=page, size=size
    )


# ── 5. GET /cguard-events ────────────────────────────────────


@router.get(
    "/cguard-events",
    response_model=DiscordBotCGuardEventListResponse,
)
async def get_discord_bot_cguard_events(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """cguard_user_status 를 디스코드 봇 관점의 이벤트 목록으로 조회한다.

    ORDER BY updated_at DESC (본 테이블에는 changed_at 컬럼이 없음).
    authenticated 는 status 값으로부터 추론한다.
    team_id 는 본 테이블에 컬럼이 없어 항상 None 이다.
    """
    offset = (page - 1) * size

    try:
        result = await db.execute(
            text("""
                SELECT
                    discord_user_id,
                    status,
                    reason,
                    updated_at
                FROM cstrike.cguard_user_status
                ORDER BY updated_at DESC
                OFFSET :offset
                LIMIT :limit
            """),
            {"offset": offset, "limit": size},
        )
        rows = result.fetchall()

        count_result = await db.execute(
            text("SELECT COUNT(*) FROM cstrike.cguard_user_status")
        )
        total = count_result.scalar() or 0
    except Exception as exc:
        logger.warning("discord_bot_admin /cguard-events 쿼리 실패: %s", exc)
        return DiscordBotCGuardEventListResponse(
            items=[], total=0, page=page, size=size
        )

    items = [
        DiscordBotCGuardEventItem(
            discord_user_id=r.discord_user_id,
            team_id=None,
            authenticated=_authenticated_from_status(r.status),
            reason=r.reason,
            changed_at=r.updated_at,
        )
        for r in rows
    ]

    return DiscordBotCGuardEventListResponse(
        items=items, total=total, page=page, size=size
    )
