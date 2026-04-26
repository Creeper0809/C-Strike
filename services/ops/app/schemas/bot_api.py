"""디스코드 봇 내부 API Pydantic 스키마."""

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field


# ── 팀 관련 요청/응답 스키마 ───────────────────────────────

class BotTeamCreateRequest(BaseModel):
    """POST /api/v1/bot/teams 요청 바디."""
    competition_id: UUID
    name: str = Field(..., max_length=100)
    captain_discord_id: str = Field(..., max_length=50)
    captain_discord_username: str | None = Field(default=None, max_length=100)


class BotTeamCreateResponse(BaseModel):
    """POST /api/v1/bot/teams 응답."""
    id: UUID
    name: str
    team_code: str
    captain_discord_id: str
    status: str
    message: str


class BotTeamJoinRequest(BaseModel):
    """POST /api/v1/bot/teams/{code}/join 요청 바디."""
    discord_user_id: str = Field(..., max_length=50)
    discord_username: str | None = Field(default=None, max_length=100)


class BotTeamJoinResponse(BaseModel):
    """POST /api/v1/bot/teams/{code}/join 응답."""
    team_id: UUID
    team_name: str
    member_id: UUID
    status: str
    message: str


class BotCaptainActionRequest(BaseModel):
    """팀장 전용 액션(승인/거절/추방) 요청 바디."""
    captain_discord_id: str = Field(..., max_length=50)
    target_discord_id: str = Field(..., max_length=50)


class BotMemberActionResponse(BaseModel):
    """팀원 상태 변경 결과 응답 (승인/거절/추방/탈퇴)."""
    member_id: UUID
    discord_username: str | None = None
    status: str
    joined_at: datetime | None = None
    message: str


class BotTeamLeaveRequest(BaseModel):
    """POST /api/v1/bot/teams/{id}/leave 요청 바디."""
    discord_user_id: str = Field(..., max_length=50)


class BotTeamDeleteRequest(BaseModel):
    """DELETE /api/v1/bot/teams/{id} 요청 바디."""
    captain_discord_id: str = Field(..., max_length=50)


class BotTeamDeleteResponse(BaseModel):
    """DELETE /api/v1/bot/teams/{id} 응답."""
    team_id: UUID
    team_name: str
    message: str


class BotTeamMemberInfo(BaseModel):
    """팀 조회 시 멤버 정보."""
    discord_username: str | None = None
    role: str
    status: str


class BotTeamInfoResponse(BaseModel):
    """GET /api/v1/bot/teams/{id} 응답."""
    id: UUID
    name: str
    team_code: str
    status: str
    member_count: int
    members: list[BotTeamMemberInfo]


class BotTeamRoleLinkRequest(BaseModel):
    """POST /api/v1/bot/teams/{id}/role-link 요청 바디."""

    guild_id: str = Field(..., max_length=50)
    discord_role_id: str = Field(..., max_length=50)
    discord_role_name: str | None = Field(default=None, max_length=100)
    requested_by_id: str | None = Field(default=None, max_length=50)
    requested_by_name: str | None = Field(default=None, max_length=100)


class BotTeamRoleLinkResponse(BaseModel):
    """POST /api/v1/bot/teams/{id}/role-link 응답."""

    team_id: UUID
    team_name: str
    team_code: str
    discord_role_id: str
    message: str


class BotMyTeamResponse(BaseModel):
    """GET /api/v1/bot/teams/my 응답 — discord_user_id로 소속 팀 조회."""
    team_id: UUID
    team_name: str
    team_code: str
    role: str
    member_status: str
    captain_discord_id: str


class BotTeamListItem(BaseModel):
    """팀 목록 아이템."""
    id: UUID
    name: str
    team_code: str
    status: str
    member_count: int
    max_members: int


class BotTeamListResponse(BaseModel):
    """GET /api/v1/bot/teams 응답 — 대회별 팀 목록."""
    teams: list[BotTeamListItem]
    total: int
    max_teams: int


# ── 플래그 제출 요청/응답 스키마 ──────────────────────────

class BotFlagSubmitRequest(BaseModel):
    """POST /api/v1/bot/flags/submit 요청 바디.

    competition_id가 None이면 서버가 현재 running 상태 대회를 자동 선택한다.
    단일 대회 운영이 기본 전제이므로 봇이 대회 ID를 몰라도 되도록 설계.
    problem_no는 UX 힌트용으로만 기록 (실제 매칭은 submitted_flag 값으로만).
    """
    competition_id: UUID | None = None
    discord_user_id: str = Field(..., max_length=50)
    submitted_flag: str = Field(..., max_length=100)
    problem_no: str | None = Field(default=None, max_length=50)


class BotFlagSubmitDetails(BaseModel):
    """플래그 정답 시 세부 정보."""
    target_team: str | None = None
    service: str | None = None
    points_earned: Decimal | None = None


class BotFlagSubmitResponse(BaseModel):
    """POST /api/v1/bot/flags/submit 응답."""
    submission_id: UUID
    verdict: str
    message: str
    details: BotFlagSubmitDetails | None = None


# ── 점수 조회 스키마 ─────────────────────────────────────

class BotRankingItem(BaseModel):
    """점수 순위 목록 아이템."""
    rank: int | None = None
    team_name: str
    total_score: Decimal
    is_my_team: bool = False


class BotMyTeamScore(BaseModel):
    """내 팀 상세 점수."""
    rank: int | None = None
    team_name: str
    total_score: Decimal
    attack_score: Decimal
    defense_score: Decimal
    sla_percentage: float


class BotScoreResponse(BaseModel):
    """GET /api/v1/bot/scores 응답."""
    round_number: int
    rankings: list[BotRankingItem]
    my_team: BotMyTeamScore | None = None


# ── 서비스 상태 조회 스키마 ──────────────────────────────

class BotServiceStatusItem(BaseModel):
    """개별 서비스 상태."""
    service_name: str
    is_up: bool
    sla_percentage: float
    last_check_at: datetime | None = None


class BotStatusResponse(BaseModel):
    """GET /api/v1/bot/status/{discord_id} 응답."""
    team_id: UUID
    team_name: str
    services: list[BotServiceStatusItem]
    overall_sla: float


# ── 티켓 생성 스키마 ─────────────────────────────────────

class BotTicketCreateRequest(BaseModel):
    """POST /api/v1/bot/tickets 요청 바디."""
    competition_id: UUID
    discord_user_id: str = Field(..., max_length=50)
    discord_username: str | None = Field(default=None, max_length=100)
    team_id: UUID | None = None
    team_name: str | None = Field(default=None, max_length=100)
    type: str = Field(..., pattern=r"^(dispute|violation)$")
    title: str = Field(..., max_length=200)
    description: str


class BotTicketCreateResponse(BaseModel):
    """POST /api/v1/bot/tickets 응답."""
    ticket_id: UUID
    ticket_number: str
    status: str
    message: str


# ── 피드백 제출 스키마 ───────────────────────────────────

class BotFeedbackCreateRequest(BaseModel):
    """POST /api/v1/bot/feedbacks 요청 바디."""
    competition_id: UUID
    discord_user_id: str = Field(..., max_length=50)
    discord_username: str | None = Field(default=None, max_length=100)
    team_id: UUID | None = None
    rating: int = Field(..., ge=1, le=5)
    content: str = Field(..., min_length=1)
    category: str = Field(default="general", pattern=r"^(general|scoring|network|service|organization)$")


class BotFeedbackCreateResponse(BaseModel):
    """POST /api/v1/bot/feedbacks 응답."""
    id: UUID
    rating: int
    category: str
    message: str
