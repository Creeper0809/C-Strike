"""팀(Team) 관련 Pydantic 스키마."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


# ── 목록 / 상세 응답 ──────────────────────────────────────

class TeamListItem(BaseModel):
    """팀 목록 아이템 (member_count 포함)."""
    id: UUID
    competition_id: UUID
    name: str
    team_code: str
    captain_discord_id: str
    subnet: str | None = None
    gateway_ip: str | None = None
    vpn_profile_issued: bool
    status: str
    member_count: int = 0
    registered_at: datetime
    approved_at: datetime | None = None
    ssh_configured: bool = False

    model_config = {"from_attributes": True}


class TeamListResponse(BaseModel):
    """페이지네이션된 팀 목록."""
    items: list[TeamListItem]
    total: int
    page: int
    size: int


class TeamResponse(BaseModel):
    """팀 상세 응답."""
    id: UUID
    competition_id: UUID
    name: str
    team_code: str
    captain_discord_id: str
    discord_role_id: str | None = None
    subnet: str | None = None
    gateway_ip: str | None = None
    vpn_profile_issued: bool
    status: str
    registered_at: datetime
    approved_at: datetime | None = None
    created_at: datetime
    updated_at: datetime | None = None
    ssh_port: int = 22
    ssh_user: str | None = None
    ssh_configured: bool = False

    model_config = {"from_attributes": True}


class TeamSshPasswordRevealResponse(BaseModel):
    """운영자용 SSH 비밀번호 일회성 조회 응답."""

    team_id: UUID
    team_name: str
    ssh_user: str | None = None
    ssh_password: str
    revealed_at: datetime
    message: str


# ── 요청 스키마 ──────────────────────────────────────────

class TeamCreate(BaseModel):
    """POST / 요청 바디 — 운영포털에서 팀 생성."""
    name: str = Field(..., min_length=1, max_length=100)
    subnet: str | None = None
    gateway_ip: str | None = None
    ssh_port: int = Field(22, ge=1, le=65535)
    ssh_user: str | None = None
    ssh_password: str | None = None  # 평문 수신 → API에서 암호화


class TeamUpdate(BaseModel):
    """PATCH /{team_id} 요청 바디 — 변경할 필드만 전송."""
    name: str | None = None
    subnet: str | None = None
    gateway_ip: str | None = None
    vpn_profile_issued: bool | None = None
    discord_role_id: str | None = None
    ssh_port: int | None = Field(None, ge=1, le=65535)
    ssh_user: str | None = None
    ssh_password: str | None = None  # 평문 수신 → API에서 암호화


class TeamDisqualifyRequest(BaseModel):
    """POST /{team_id}/disqualify 요청 바디."""
    reason: str = Field(..., min_length=1)


# ── 상태 전환 응답 ────────────────────────────────────────

class TeamApproveResponse(BaseModel):
    """팀 승인 결과."""
    id: UUID
    name: str
    status: str
    approved_at: datetime | None = None
    message: str


class TeamDisqualifyResponse(BaseModel):
    """팀 실격 결과."""
    id: UUID
    name: str
    status: str
    message: str
    reason: str


# ── 팀원 ─────────────────────────────────────────────────

class TeamMemberItem(BaseModel):
    """팀원 아이템."""
    id: UUID
    discord_user_id: str
    discord_username: str | None = None
    role: str
    status: str
    joined_at: datetime | None = None

    model_config = {"from_attributes": True}


class TeamMemberListResponse(BaseModel):
    """팀원 목록 응답."""
    team_id: UUID
    team_name: str
    items: list[TeamMemberItem]
    total: int


class TeamMemberCreateRequest(BaseModel):
    """운영포털에서 디스코드 멤버를 팀원으로 추가한다."""

    discord_user_id: str = Field(
        ...,
        max_length=32,
        pattern=r"^\d{18,20}$",
    )
    role: Literal["captain", "member"] = "member"


class TeamMemberCreateResponse(TeamMemberItem):
    """팀원 추가/재활성화 응답."""

    team_id: UUID
    team_name: str
    message: str
    vpn_username: str | None = None
    vpn_ip: str | None = None
    generated_vpn_password: str | None = None
    vpn_credentials_issued: bool = False


class TeamMemberRemoveResponse(TeamMemberItem):
    """팀원 퇴장/삭제 응답."""

    team_id: UUID
    team_name: str
    message: str
    vpn_username: str | None = None
    vpn_disabled: bool = False


class TeamMutationItem(BaseModel):
    """팀 관련 작업 이력 아이템."""

    id: UUID
    operation_type: str
    status: str
    requested_by_name: str
    payload: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error_detail: str | None = None
    started_at: datetime
    completed_at: datetime | None = None
    retryable: bool = False

    model_config = {"from_attributes": True}


class TeamMutationListResponse(BaseModel):
    """팀 작업 이력 목록 응답."""

    team_id: UUID
    team_name: str
    items: list[TeamMutationItem]
    total: int


class TeamMutationRetryResponse(BaseModel):
    """팀 작업 이력 재시도 응답."""

    mutation_id: UUID
    operation_type: str
    message: str
    team_deleted: bool = False


# ── 팀 서비스 ────────────────────────────────────────────

class TeamServiceItem(BaseModel):
    """팀 서비스 인스턴스 아이템 (service_name 포함)."""
    id: UUID
    service_id: UUID
    service_name: str
    host_ip: str
    port: int
    container_id: str | None = None
    status: str
    last_health_check_at: datetime | None = None
    last_health_check_result: bool | None = None
    health_check_endpoint: str | None = None
    healthcheck_scenarios: dict[str, Any] | None = None
    last_health_check_type: str | None = None
    last_health_check_error: str | None = None
    last_health_check_response_time_ms: int | None = None

    model_config = {"from_attributes": True}


class TeamServiceHealthcheckStepResult(BaseModel):
    """실시간 팀 서비스 헬스체크 step 결과."""

    step_index: int
    name: str
    request_label: str
    status: Literal["passed", "failed", "not_run"]
    response_time_ms: int | None = None
    error_message: str | None = None


class TeamServiceHealthcheckLiveResponse(BaseModel):
    """팀 서비스에 대한 실시간 헬스체크 응답."""

    team_id: UUID
    team_service_id: UUID
    service_id: UUID
    service_name: str
    check_type: str
    is_up: bool
    response_time_ms: int | None = None
    error_message: str | None = None
    checked_at: datetime
    steps: list[TeamServiceHealthcheckStepResult]


class TeamServiceListResponse(BaseModel):
    """팀 서비스 목록 응답."""
    team_id: UUID
    team_name: str
    items: list[TeamServiceItem]
    total: int
