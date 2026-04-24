"""대시보드 스키마."""

from pydantic import BaseModel


class SystemHealthItem(BaseModel):
    name: str
    status: str  # ok/degraded/down/not_connected/unknown
    version: str | None = None


class DashboardStatsResponse(BaseModel):
    active_teams: int
    scoring_round: int
    total_rounds: int
    open_tickets: int
    current_vulnpack: int
    system_health: list[SystemHealthItem]
    scoring_success_rate: float
    total_containers: int
    running_containers: int
