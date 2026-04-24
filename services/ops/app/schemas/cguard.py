"""C-Guard 모니터링 응답 스키마."""

from pydantic import BaseModel


# ── 전체 요약 ──────────────────────────────────────────────────

class CGuardSummaryResponse(BaseModel):
    """C-Guard 전체 요약 통계."""
    total_sessions: int = 0
    active_sessions: int = 0
    blocked_sessions: int = 0
    restricted_sessions: int = 0
    c_guard_ok_count: int = 0
    total_events: int = 0
    active_bans: int = 0


# ── 세션 ───────────────────────────────────────────────────────

class CGuardSessionItem(BaseModel):
    """C-Guard 세션 목록 아이템."""
    session_id: str
    user_id: str
    username: str | None = None
    team_name: str | None = None
    status: str
    decision_status: str | None = None
    decision_reason_code: str | None = None
    risk_score: float | None = None
    last_heartbeat_at: str | None = None
    last_ip: str | None = None
    created_at: str


class CGuardSessionListResponse(BaseModel):
    """C-Guard 세션 목록 응답."""
    items: list[CGuardSessionItem]
    total: int


# ── 이벤트 ─────────────────────────────────────────────────────

class CGuardEventItem(BaseModel):
    """C-Guard 이벤트 목록 아이템."""
    event_id: int
    timestamp: str
    event_type: str
    severity: str
    session_id: str
    username: str | None = None
    client_version: str
    evidence: dict | None = None


class CGuardEventListResponse(BaseModel):
    """C-Guard 이벤트 목록 응답."""
    items: list[CGuardEventItem]
    total: int


# ── 차단 ───────────────────────────────────────────────────────

class CGuardBanItem(BaseModel):
    """C-Guard 차단 목록 아이템."""
    ban_id: str
    scope: str
    target_id: str
    reason: str | None = None
    reason_code: str | None = None
    created_by: str
    created_at: str
    expires_at: str | None = None
    status: str


class CGuardBanListResponse(BaseModel):
    """C-Guard 차단 목록 응답."""
    items: list[CGuardBanItem]
    total: int


# ── 감사로그 ───────────────────────────────────────────────────

class CGuardAuditLogItem(BaseModel):
    """C-Guard 감사로그 아이템."""
    audit_id: str
    at: str
    actor: str
    action: str
    object_type: str | None = None
    object_id: str | None = None
    detail: dict | None = None


class CGuardAuditLogListResponse(BaseModel):
    """C-Guard 감사로그 목록 응답."""
    items: list[CGuardAuditLogItem]
    total: int


# ── 디스코드 액션 ──────────────────────────────────────────────

class CGuardDiscordActionItem(BaseModel):
    """C-Guard 디스코드 액션 아이템."""
    action_id: str
    action_type: str
    status: str
    discord_user_id: str
    reason_code: str | None = None
    reason_text: str | None = None
    created_at: str
    updated_at: str
    callback_status: str | None = None


class CGuardDiscordActionListResponse(BaseModel):
    """C-Guard 디스코드 액션 목록 응답."""
    items: list[CGuardDiscordActionItem]
    total: int
