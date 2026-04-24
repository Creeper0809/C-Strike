"""디스코드 봇 관리 대시보드 응답 스키마.

운영포털 "디스코드 봇" 탭에서 봇 활동 로그/이벤트/통계를 조회할 때 사용한다.
C-가드 `schemas/cguard.py`의 스타일을 그대로 따른다.
100% 조회 전용 (액션 없음)이다.
"""

from datetime import datetime

from pydantic import BaseModel


# ── 전체 요약 ──────────────────────────────────────────────────


class DiscordBotSummaryResponse(BaseModel):
    """디스코드 봇 전체 요약 통계 (프론트 DiscordBotSummary 타입과 1:1)."""

    bot_status: str = "unknown"  # ok | degraded | down | unknown
    bot_latency_ms: int | None = None  # /health 왕복 ms
    last_heartbeat_at: datetime | None = None  # 마지막 성공 시각

    total_events: int = 0  # ops_audit_logs 총 건수
    total_broadcasts: int = 0  # scheduled+team+hint 합계
    total_relays: int = 0  # relay_events 총 건수
    total_cguard_events: int = 0  # cguard_user_status 총 건수

    recent_events_24h: int = 0
    recent_broadcasts_24h: int = 0
    recent_relays_24h: int = 0
    recent_cguard_events_24h: int = 0


# ── 운영 감사 이벤트 (ops_audit_logs 기반) ──────────────────────


class DiscordBotEventItem(BaseModel):
    """디스코드 봇 이벤트 목록 아이템 (ops_audit_logs 매핑).

    운영포털 `ops_audit_logs` 컬럼을 디스코드 봇 문맥의 이름으로 노출한다:
    - log_type  ← target_type (예: "team", "ticket", "announcement")
    - event_key ← action      (예: "team.create", "ticket.close")
    - team_id   ← target_id   (target_type 이 팀 관련일 때)
    """

    id: int
    log_type: str | None = None
    event_key: str
    actor_id: str | None = None
    team_id: str | None = None
    details: dict | None = None
    created_at: datetime | None = None


class DiscordBotEventListResponse(BaseModel):
    """디스코드 봇 이벤트 목록 응답."""

    items: list[DiscordBotEventItem]
    total: int
    page: int
    size: int


# ── 공지 (scheduled / team / hint 통합) ────────────────────────


class DiscordBotBroadcastItem(BaseModel):
    """디스코드 봇 공지 아이템 (3개 테이블 UNION 결과).

    kind: "scheduled" | "team" | "hint"
      - scheduled: cstrike.scheduled_announcements
      - team     : cstrike.team_announcements
      - hint     : cstrike.team_hints
    """

    id: int
    kind: str
    channel_id: str | None = None
    title: str | None = None
    content: str = ""
    scheduled_at: datetime | None = None
    sent_at: datetime | None = None
    created_at: datetime | None = None


class DiscordBotBroadcastListResponse(BaseModel):
    """디스코드 봇 공지 목록 응답."""

    items: list[DiscordBotBroadcastItem]
    total: int
    page: int
    size: int


# ── 릴레이 이벤트 (relay_events 기반) ──────────────────────────


class DiscordBotRelayItem(BaseModel):
    """디스코드 봇 릴레이 이벤트 아이템.

    sent_at 은 `relay_dispatch_history`에서 동일 채널의 가장 최근 발송
    시각을 LEFT JOIN 으로 가져온다. 매칭되는 이력이 없으면 None.
    """

    id: int
    event_type: str
    channel_id: str | None = None
    payload: dict | None = None
    sent_at: datetime | None = None
    created_at: datetime | None = None


class DiscordBotRelayListResponse(BaseModel):
    """디스코드 봇 릴레이 이벤트 목록 응답."""

    items: list[DiscordBotRelayItem]
    total: int
    page: int
    size: int


# ── C-가드 사용자 상태 (cguard_user_status 기반) ───────────────


class DiscordBotCGuardEventItem(BaseModel):
    """디스코드 봇 관점의 C-가드 이벤트 아이템.

    실 테이블 `cstrike.cguard_user_status` 컬럼과 매핑:
    - discord_user_id (PK)
    - authenticated ← (status 가 'ok'/'active' 계열이면 True)
    - reason        ← reason
    - changed_at    ← updated_at
    team_id 는 본 테이블에 컬럼이 없으므로 항상 None 이다.
    """

    discord_user_id: str
    team_id: str | None = None
    authenticated: bool = False
    reason: str | None = None
    changed_at: datetime | None = None


class DiscordBotCGuardEventListResponse(BaseModel):
    """디스코드 봇 C-가드 이벤트 목록 응답."""

    items: list[DiscordBotCGuardEventItem]
    total: int
    page: int
    size: int
