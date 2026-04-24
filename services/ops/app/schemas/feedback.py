"""피드백(Feedback) Pydantic 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


# -- 피드백 목록 --

class FeedbackItem(BaseModel):
    """피드백 목록 아이템."""
    id: UUID
    competition_id: UUID
    discord_user_id: str
    discord_username: str | None = None
    team_id: UUID | None = None
    team_name: str | None = None
    rating: int
    content: str
    category: str
    created_at: datetime

    model_config = {"from_attributes": True}


class FeedbackListResponse(BaseModel):
    """페이지네이션된 피드백 목록."""
    items: list[FeedbackItem]
    total: int
    page: int
    size: int


# -- 피드백 통계 --

class CategoryBreakdown(BaseModel):
    """카테고리별 피드백 집계."""
    count: int
    average_rating: float


class FeedbackStatsResponse(BaseModel):
    """피드백 통계 응답."""
    competition_id: UUID
    total_feedbacks: int
    average_rating: float
    rating_distribution: dict[str, int]
    category_breakdown: dict[str, CategoryBreakdown]
    participation_rate: float
