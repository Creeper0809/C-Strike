"""플래그(Flag) 및 플래그 제출(FlagSubmission) Pydantic 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


# -- 플래그 목록 --

class FlagItem(BaseModel):
    """플래그 목록 아이템."""
    id: UUID
    round_number: int
    round_id: UUID
    team_id: UUID
    team_name: str
    service_id: UUID
    service_name: str
    flag_value: str
    is_active: bool
    planted_at: datetime | None = None
    expires_at: datetime | None = None

    model_config = {"from_attributes": True}


class FlagListResponse(BaseModel):
    """페이지네이션된 플래그 목록."""
    items: list[FlagItem]
    total: int
    page: int
    size: int


# -- 제출 기록 목록 --

class FlagSubmissionItem(BaseModel):
    """플래그 제출 기록 목록 아이템."""
    id: UUID
    competition_id: UUID
    round_number: int | None = None
    submitter_team_id: UUID
    submitter_team_name: str
    target_team_id: UUID | None = None
    target_team_name: str | None = None
    service_id: UUID | None = None
    service_name: str | None = None
    submitted_flag: str
    verdict: str
    submitter_discord_id: str | None = None
    submitted_at: datetime

    model_config = {"from_attributes": True}


class FlagSubmissionListResponse(BaseModel):
    """페이지네이션된 제출 기록 목록."""
    items: list[FlagSubmissionItem]
    total: int
    page: int
    size: int


# -- 제출 상세 --

class FlagSubmissionDetail(BaseModel):
    """플래그 제출 기록 상세 응답."""
    id: UUID
    competition_id: UUID
    round_id: UUID | None = None
    round_number: int | None = None
    submitter_team_id: UUID
    submitter_team_name: str
    target_team_id: UUID | None = None
    target_team_name: str | None = None
    service_id: UUID | None = None
    service_name: str | None = None
    submitted_flag: str
    flag_id: UUID | None = None
    verdict: str
    submitter_discord_id: str | None = None
    submitted_at: datetime

    model_config = {"from_attributes": True}


# -- 플래그 통계 --

class TeamAttackStat(BaseModel):
    """팀별 공격 통계."""
    team_id: UUID
    team_name: str
    total_submissions: int
    correct_submissions: int
    accuracy_rate: float
    unique_teams_attacked: int


class TeamDefenseStat(BaseModel):
    """팀별 방어 통계."""
    team_id: UUID
    team_name: str
    flags_stolen: int
    flags_total: int
    defense_rate: float


class ServiceStat(BaseModel):
    """서비스별 플래그 통계."""
    service_id: UUID
    service_name: str
    total_captures: int
    capture_rate_per_round: float


class FlagStatsResponse(BaseModel):
    """플래그 통계 응답."""
    competition_id: UUID
    total_flags_generated: int
    total_submissions: int
    submissions_by_verdict: dict[str, int]
    accuracy_rate: float
    team_attack_stats: list[TeamAttackStat]
    team_defense_stats: list[TeamDefenseStat]
    service_stats: list[ServiceStat]
