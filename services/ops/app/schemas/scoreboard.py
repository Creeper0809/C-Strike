"""스코어보드 공개 API Pydantic 스키마."""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel


# ── 대회 기본 정보 ──────────────────────────────────────────

class ScoreboardTeamEntry(BaseModel):
    """공개 팀 카드 항목 — 스코어보드 v2 프론트가 색상 매핑에 사용."""
    id: str
    name: str
    color: str


class ScoreboardServiceEntry(BaseModel):
    """공개 서비스 카드 항목."""
    id: str
    name: str
    category: str


class ScoreboardVulnpackEntry(BaseModel):
    """취약점팩 일정 항목 — released 여부와 포함 서비스 이름 목록."""
    pack_number: int
    released: bool
    services: list[str]


class ScoreboardInfoResponse(BaseModel):
    """GET /{competition_id}/info 응답 — 대회 기본 정보 + v2 연동 메타."""
    competition_id: UUID
    name: str
    status: str
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None
    actual_start_at: datetime | None = None
    current_round: int
    scoring_interval_seconds: int
    total_teams: int
    total_services: int
    # ── 스코어보드 v2 연동 신규 필드 (Task 10) ──
    is_frozen: bool = False
    teams: list[ScoreboardTeamEntry] = []
    services: list[ScoreboardServiceEntry] = []
    all_services: list[ScoreboardServiceEntry] = []
    vulnpacks: list[ScoreboardVulnpackEntry] = []


# ── 순위표 ──────────────────────────────────────────────────

class RankingEntry(BaseModel):
    """팀 순위 항목."""
    rank: int
    rank_change: int = 0
    team_name: str
    total_score: float
    attack_score: float
    defense_score: float
    sla_percentage: float
    flags_captured: int
    services_up: int
    services_total: int


class ScoreboardRankingsResponse(BaseModel):
    """GET /{competition_id}/rankings 응답 — 실시간 순위."""
    competition_id: UUID
    round_number: int
    updated_at: datetime | None = None
    rankings: list[RankingEntry]


# ── 점수 추이 차트 ──────────────────────────────────────────

class ScoreboardChartResponse(BaseModel):
    """GET /{competition_id}/chart 응답 — 라운드별 점수 추이."""
    competition_id: UUID
    total_rounds: int
    teams: list[str]
    rounds: list[int]
    scores: dict[str, list[float]]


# ── 서비스 상태 매트릭스 ──────────────────────────────────────

class ServiceInfo(BaseModel):
    """매트릭스 서비스 헤더."""
    id: UUID
    name: str


class ServiceStatusEntry(BaseModel):
    """팀x서비스 셀 데이터."""
    service_id: UUID
    is_up: bool
    sla_percentage: float


class MatrixTeamRow(BaseModel):
    """매트릭스 팀 행."""
    team_name: str
    statuses: list[ServiceStatusEntry]


class ScoreboardMatrixResponse(BaseModel):
    """GET /{competition_id}/matrix 응답 — 서비스 상태 매트릭스."""
    competition_id: UUID
    round_number: int
    services: list[ServiceInfo]
    matrix: list[MatrixTeamRow]


# ── 이벤트 피드 ──────────────────────────────────────────────

class EventEntry(BaseModel):
    """이벤트 항목."""
    id: UUID
    type: str  # flag_captured | sla_change | rank_change
    timestamp: datetime
    round_number: int
    details: dict[str, Any]


class ScoreboardEventsResponse(BaseModel):
    """GET /{competition_id}/events 응답 — 최근 이벤트 피드."""
    competition_id: UUID
    events: list[EventEntry]
