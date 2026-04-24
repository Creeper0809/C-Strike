"""대회 결과 리포트 / 타임라인 / 내보내기 Pydantic 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


# -- 결과 리포트 --

class TeamRanking(BaseModel):
    """순위별 팀 점수 정보."""
    rank: int
    team_name: str
    team_id: UUID
    total_score: float
    attack_score: float
    defense_score: float
    sla_percentage: float = Field(description="SLA 가용률(%)")
    flags_captured: int
    flags_lost: int


class ServiceStat(BaseModel):
    """서비스별 통계."""
    service_name: str
    service_id: UUID
    total_flags_captured: int
    average_sla: float
    most_attacked_team: str | None = None


class CompetitionResultsResponse(BaseModel):
    """GET /results 응답 — 대회 전체 결과 리포트."""
    competition_id: UUID
    competition_name: str
    status: str
    duration_hours: float
    total_rounds: int
    total_teams: int
    total_flag_submissions: int
    total_correct_flags: int
    rankings: list[TeamRanking]
    service_stats: list[ServiceStat]


# -- 타임라인 --

class TimelineEvent(BaseModel):
    """타임라인 개별 이벤트."""
    timestamp: datetime
    type: str = Field(
        description="이벤트 타입: competition_started, round_completed, flag_captured, emergency_pause 등",
    )
    details: dict = Field(default_factory=dict)


class TimelineResponse(BaseModel):
    """GET /timeline 응답 — 타임라인 리플레이 데이터."""
    competition_id: UUID
    total_rounds: int
    events: list[TimelineEvent]
