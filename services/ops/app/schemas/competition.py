"""대회(Competition) Pydantic 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


# ── 요청 스키마 ──────────────────────────────────────────

class CompetitionCreate(BaseModel):
    """POST /api/v1/competitions 요청 바디."""
    name: str = Field(..., max_length=200)
    description: str | None = None
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None
    scoring_round_interval_seconds: int = Field(default=120, gt=0)
    max_teams: int = Field(default=20, gt=0)
    max_members_per_team: int = Field(default=8, gt=0)
    network_participant_subnet: str = "10.10.0.0/16"
    network_ops_subnet: str = "10.20.0.0/16"


class CompetitionUpdate(BaseModel):
    """PATCH /api/v1/competitions/{id} 요청 바디."""
    name: str | None = Field(default=None, max_length=200)
    description: str | None = None
    status: str | None = None
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None
    scoring_round_interval_seconds: int | None = Field(default=None, gt=0)
    max_teams: int | None = Field(default=None, gt=0)
    max_members_per_team: int | None = Field(default=None, gt=0)
    flag_rotation_enabled: bool | None = None


class PauseResumeRequest(BaseModel):
    """POST /{id}/pause, /{id}/resume 요청 바디."""
    reason: str = Field(..., min_length=1)


# ── 응답 스키마 ──────────────────────────────────────────

class CompetitionResponse(BaseModel):
    """대회 상세 응답."""
    id: UUID
    name: str
    description: str | None = None
    status: str
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None
    actual_start_at: datetime | None = None
    actual_end_at: datetime | None = None
    scoring_round_interval_seconds: int
    flag_rotation_enabled: bool
    max_teams: int
    max_members_per_team: int
    network_participant_subnet: str
    network_ops_subnet: str
    created_by: UUID
    created_by_name: str | None = None
    created_at: datetime
    updated_at: datetime | None = None
    team_count: int = 0
    current_round: int = 0

    model_config = {"from_attributes": True}


class CompetitionListItem(BaseModel):
    """대회 목록 아이템."""
    id: UUID
    name: str
    status: str
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None
    actual_start_at: datetime | None = None
    max_teams: int
    created_at: datetime

    model_config = {"from_attributes": True}


class CompetitionListResponse(BaseModel):
    """페이지네이션된 대회 목록."""
    items: list[CompetitionListItem]
    total: int
    page: int
    size: int


class StateTransitionResponse(BaseModel):
    """상태 전환 결과 응답."""
    id: UUID
    status: str
    message: str
    actual_start_at: datetime | None = None
    actual_end_at: datetime | None = None
    reason: str | None = None
    total_rounds: int | None = None
    final_rankings_count: int | None = None
