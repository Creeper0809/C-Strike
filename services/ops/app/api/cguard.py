"""C-Guard 모니터링 API 라우터 — LLM 부정행위 방지 시스템 조회."""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.api.deps import get_current_operator
from app.external.cguard import CGuardClient
from app.models.operator import Operator
from app.schemas.cguard import (
    CGuardSummaryResponse,
    CGuardSessionListResponse,
    CGuardSessionItem,
    CGuardEventListResponse,
    CGuardEventItem,
    CGuardBanListResponse,
    CGuardBanItem,
    CGuardAuditLogListResponse,
    CGuardAuditLogItem,
)

router = APIRouter(tags=["C-Guard 모니터링"])

# ── C-Guard 클라이언트 ─────────────────────────────────────────
cguard_client = CGuardClient(
    settings.CGUARD_SERVER_URL,
    settings.CGUARD_INTEGRATION_TOKEN,
)


# ── 헬퍼: C-Guard 서버 프록시 에러 처리 ───────────────────────

def _handle_cguard_error(exc: Exception) -> HTTPException:
    """C-Guard 서버 통신 오류를 적절한 HTTPException으로 변환한다."""
    if isinstance(exc, httpx.ConnectError):
        return HTTPException(
            status_code=502,
            detail="C-Guard 서버에 연결할 수 없습니다.",
        )
    if isinstance(exc, (httpx.ConnectTimeout, httpx.TimeoutException)):
        return HTTPException(
            status_code=504,
            detail="C-Guard 서버 응답 시간이 초과되었습니다.",
        )
    if isinstance(exc, httpx.HTTPStatusError):
        return HTTPException(
            status_code=exc.response.status_code,
            detail=f"C-Guard 서버 오류: {exc.response.status_code}",
        )
    return HTTPException(
        status_code=502,
        detail=f"C-Guard 서버 통신 중 알 수 없는 오류가 발생했습니다: {exc}",
    )


# ── 1. GET /summary ────────────────────────────────────────────

@router.get("/summary", response_model=CGuardSummaryResponse)
async def get_cguard_summary(
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """C-Guard 전체 요약 통계를 조회한다.

    우선 C-Guard 서버 API를 호출하고, 연결 실패 시 DB에서 직접 집계한다.
    """
    # C-Guard 서버 프록시 시도
    try:
        data = await cguard_client.get_summary()
        return CGuardSummaryResponse(**data)
    except Exception:
        pass  # 서버 연결 실패 → DB 폴백

    # DB 직접 집계 (폴백)
    # 외주 DDL CHECK 제약: sessions.status = 'ACTIVE'|'RESTRICTED'|'BLOCKED'|'OFFLINE' (대문자)
    # c_guard_ok_count는 sessions.decision_status = 'ok' 기준 (정책 판정 결과)
    result = await db.execute(
        text("""
            SELECT
                COUNT(*) AS total_sessions,
                COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active_sessions,
                COUNT(*) FILTER (WHERE status = 'BLOCKED') AS blocked_sessions,
                COUNT(*) FILTER (WHERE status = 'RESTRICTED') AS restricted_sessions,
                COUNT(*) FILTER (WHERE decision_status = 'ok') AS c_guard_ok_count
            FROM cstrike.cguard_sessions
        """)
    )
    session_row = result.fetchone()

    event_result = await db.execute(
        text("SELECT COUNT(*) AS cnt FROM cstrike.cguard_events")
    )
    total_events = event_result.scalar() or 0

    # 외주 DDL CHECK 제약: bans.status = 'ACTIVE'|'EXPIRED'|'REVOKED' (대문자)
    ban_result = await db.execute(
        text("""
            SELECT COUNT(*) AS cnt
            FROM cstrike.cguard_bans
            WHERE status = 'ACTIVE'
        """)
    )
    active_bans = ban_result.scalar() or 0

    return CGuardSummaryResponse(
        total_sessions=session_row.total_sessions if session_row else 0,
        active_sessions=session_row.active_sessions if session_row else 0,
        blocked_sessions=session_row.blocked_sessions if session_row else 0,
        restricted_sessions=session_row.restricted_sessions if session_row else 0,
        c_guard_ok_count=session_row.c_guard_ok_count if session_row else 0,
        total_events=total_events,
        active_bans=active_bans,
    )


# ── 2. GET /sessions ───────────────────────────────────────────

@router.get("/sessions", response_model=CGuardSessionListResponse)
async def get_cguard_sessions(
    status: str | None = Query(None, description="세션 상태 필터 (active, blocked, restricted, ok)"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """C-Guard 세션 목록을 DB에서 직접 조회한다."""
    offset = (page - 1) * size

    conditions = ["1=1"]
    params: dict = {"limit": size, "offset": offset}

    if status:
        # sessions.status CHECK 값은 대문자 ('ACTIVE'/'RESTRICTED'/'BLOCKED'/'OFFLINE')
        conditions.append("s.status = :status")
        params["status"] = status.upper()

    where_clause = " AND ".join(conditions)

    # 외주 DDL: cguard_users는 team_name 컬럼 없음 → cguard_teams JOIN으로 t.name 조회
    result = await db.execute(
        text(f"""
            SELECT
                s.session_id,
                s.user_id,
                u.username,
                t.name AS team_name,
                s.status,
                s.decision_status,
                s.decision_reason_code,
                s.risk_score,
                s.last_heartbeat_at,
                s.last_ip,
                s.created_at
            FROM cstrike.cguard_sessions s
            LEFT JOIN cstrike.cguard_users u ON s.user_id = u.user_id
            LEFT JOIN cstrike.cguard_teams t ON s.team_id = t.team_id
            WHERE {where_clause}
            ORDER BY s.created_at DESC
            OFFSET :offset
            LIMIT :limit
        """),
        params,
    )
    rows = result.fetchall()

    # 전체 건수
    count_result = await db.execute(
        text(f"""
            SELECT COUNT(*) AS cnt
            FROM cstrike.cguard_sessions s
            WHERE {where_clause}
        """),
        params,
    )
    total = count_result.scalar() or 0

    items = [
        CGuardSessionItem(
            session_id=str(r.session_id),
            user_id=str(r.user_id),
            username=r.username,
            team_name=r.team_name,
            status=r.status,
            decision_status=r.decision_status,
            decision_reason_code=r.decision_reason_code,
            risk_score=r.risk_score,
            last_heartbeat_at=r.last_heartbeat_at.isoformat() if r.last_heartbeat_at else None,
            last_ip=r.last_ip,
            created_at=r.created_at.isoformat() if r.created_at else "",
        )
        for r in rows
    ]

    return CGuardSessionListResponse(items=items, total=total)


# ── 3. GET /sessions/{session_id} ──────────────────────────────

@router.get("/sessions/{session_id}")
async def get_cguard_session_detail(
    session_id: str,
    current_operator: Operator = Depends(get_current_operator),
):
    """특정 세션의 상세 정보를 C-Guard 서버에서 조회한다."""
    try:
        data = await cguard_client.get_session(session_id)
        return data
    except Exception as exc:
        raise _handle_cguard_error(exc)


# ── 4. GET /participants/{user_id} ─────────────────────────────

@router.get("/participants/{user_id}")
async def get_cguard_participant(
    user_id: str,
    current_operator: Operator = Depends(get_current_operator),
):
    """특정 참가자의 C-Guard 정보를 C-Guard 서버에서 조회한다."""
    try:
        data = await cguard_client.get_participant(user_id)
        return data
    except Exception as exc:
        raise _handle_cguard_error(exc)


# ── 5. GET /events ─────────────────────────────────────────────

@router.get("/events", response_model=CGuardEventListResponse)
async def get_cguard_events(
    severity: str | None = Query(None, description="심각도 필터 (info, warning, critical)"),
    event_type: str | None = Query(None, description="이벤트 유형 필터"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """C-Guard 이벤트 목록을 DB에서 직접 조회한다."""
    offset = (page - 1) * size

    conditions = ["1=1"]
    params: dict = {"limit": size, "offset": offset}

    if severity:
        conditions.append("e.severity = :severity")
        params["severity"] = severity
    if event_type:
        conditions.append("e.event_type = :event_type")
        params["event_type"] = event_type

    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT
                e.event_id,
                e.timestamp,
                e.event_type,
                e.severity,
                e.session_id,
                u.username,
                e.client_version,
                e.evidence
            FROM cstrike.cguard_events e
            LEFT JOIN cstrike.cguard_users u ON e.user_id = u.user_id
            WHERE {where_clause}
            ORDER BY e.timestamp DESC
            OFFSET :offset
            LIMIT :limit
        """),
        params,
    )
    rows = result.fetchall()

    count_result = await db.execute(
        text(f"""
            SELECT COUNT(*) AS cnt
            FROM cstrike.cguard_events e
            WHERE {where_clause}
        """),
        params,
    )
    total = count_result.scalar() or 0

    items = [
        CGuardEventItem(
            event_id=r.event_id,
            timestamp=r.timestamp.isoformat() if r.timestamp else "",
            event_type=r.event_type,
            severity=r.severity,
            session_id=str(r.session_id),
            username=r.username,
            client_version=r.client_version or "",
            evidence=r.evidence,
        )
        for r in rows
    ]

    return CGuardEventListResponse(items=items, total=total)


# ── 6. GET /bans ───────────────────────────────────────────────

@router.get("/bans", response_model=CGuardBanListResponse)
async def get_cguard_bans(
    status: str | None = Query(None, alias="ban_status", description="차단 상태 필터 (active, expired, revoked)"),
    scope: str | None = Query(None, description="차단 범위 필터 (user, team, ip)"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """C-Guard 차단 목록을 DB에서 직접 조회한다."""
    offset = (page - 1) * size

    conditions = ["1=1"]
    params: dict = {"limit": size, "offset": offset}

    if status:
        # bans.status CHECK 값은 대문자 ('ACTIVE'/'EXPIRED'/'REVOKED')
        conditions.append("b.status = :status")
        params["status"] = status.upper()
    if scope:
        # bans.scope CHECK 값은 소문자 ('user'/'team'/'session')
        conditions.append("b.scope = :scope")
        params["scope"] = scope.lower()

    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT
                b.ban_id,
                b.scope,
                b.target_id,
                b.reason,
                b.reason_code,
                b.created_by,
                b.created_at,
                b.expires_at,
                b.status
            FROM cstrike.cguard_bans b
            WHERE {where_clause}
            ORDER BY b.created_at DESC
            OFFSET :offset
            LIMIT :limit
        """),
        params,
    )
    rows = result.fetchall()

    count_result = await db.execute(
        text(f"""
            SELECT COUNT(*) AS cnt
            FROM cstrike.cguard_bans b
            WHERE {where_clause}
        """),
        params,
    )
    total = count_result.scalar() or 0

    items = [
        CGuardBanItem(
            ban_id=str(r.ban_id),
            scope=r.scope,
            target_id=str(r.target_id),
            reason=r.reason,
            reason_code=r.reason_code,
            created_by=r.created_by or "",
            created_at=r.created_at.isoformat() if r.created_at else "",
            expires_at=r.expires_at.isoformat() if r.expires_at else None,
            status=r.status,
        )
        for r in rows
    ]

    return CGuardBanListResponse(items=items, total=total)


# ── 7. GET /audit-logs ─────────────────────────────────────────

@router.get("/audit-logs", response_model=CGuardAuditLogListResponse)
async def get_cguard_audit_logs(
    action: str | None = Query(None, description="액션 필터"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """C-Guard 감사로그를 DB에서 직접 조회한다."""
    offset = (page - 1) * size

    conditions = ["1=1"]
    params: dict = {"limit": size, "offset": offset}

    if action:
        conditions.append("a.action = :action")
        params["action"] = action

    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT
                a.audit_id,
                a.at,
                a.actor,
                a.action,
                a.object_type,
                a.object_id,
                a.detail
            FROM cstrike.cguard_audit_logs a
            WHERE {where_clause}
            ORDER BY a.at DESC
            OFFSET :offset
            LIMIT :limit
        """),
        params,
    )
    rows = result.fetchall()

    count_result = await db.execute(
        text(f"""
            SELECT COUNT(*) AS cnt
            FROM cstrike.cguard_audit_logs a
            WHERE {where_clause}
        """),
        params,
    )
    total = count_result.scalar() or 0

    items = [
        CGuardAuditLogItem(
            audit_id=str(r.audit_id),
            at=r.at.isoformat() if r.at else "",
            actor=r.actor or "",
            action=r.action,
            object_type=r.object_type,
            object_id=str(r.object_id) if r.object_id else None,
            detail=r.detail,
        )
        for r in rows
    ]

    return CGuardAuditLogListResponse(items=items, total=total)


# ── 8. GET /discord/actions ────────────────────────────────────

@router.get("/discord/actions")
async def get_cguard_discord_actions(
    status: str | None = Query(None, alias="action_status", description="액션 상태 필터"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    current_operator: Operator = Depends(get_current_operator),
):
    """디스코드 연동 액션 목록을 C-Guard 서버에서 조회한다."""
    params: dict = {"page": page, "size": size}
    if status:
        params["status"] = status

    try:
        data = await cguard_client.get_discord_actions(params=params)
        return data
    except Exception as exc:
        raise _handle_cguard_error(exc)


# ── 9. POST /proof/verify ─────────────────────────────────────

@router.post("/proof/verify")
async def verify_cguard_proof(
    body: dict,
    current_operator: Operator = Depends(get_current_operator),
):
    """증빙 자료를 C-Guard 서버에 전달하여 검증한다."""
    try:
        data = await cguard_client.verify_proof(body)
        return data
    except Exception as exc:
        raise _handle_cguard_error(exc)


# ── 10. GET /reason-codes ─────────────────────────────────────

@router.get("/reason-codes")
async def get_cguard_reason_codes(
    current_operator: Operator = Depends(get_current_operator),
):
    """C-Guard 사유 코드 목록을 C-Guard 서버에서 조회한다."""
    try:
        data = await cguard_client.get_reason_codes()
        return data
    except Exception as exc:
        raise _handle_cguard_error(exc)
