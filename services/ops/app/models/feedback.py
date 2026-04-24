"""참가자 피드백(Feedback) 모델."""

from uuid import uuid4

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class Feedback(Base):
    """대회 종료 후 참가자가 디스코드 봇으로 제출하는 피드백."""

    __tablename__ = "feedbacks"
    __table_args__ = (
        UniqueConstraint("competition_id", "discord_user_id", name="uq_feedbacks_competition_user"),
        CheckConstraint("rating >= 1 AND rating <= 5", name="chk_feedbacks_rating"),
        CheckConstraint(
            "category IN ('general', 'scoring', 'network', 'service', 'organization')",
            name="chk_feedbacks_category",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    competition_id = Column(UUID(as_uuid=True), ForeignKey("competitions.id", ondelete="RESTRICT"), nullable=False)
    discord_user_id = Column(String(50), nullable=False)
    discord_username = Column(String(100))
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="SET NULL"))
    rating = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    category = Column(String(30), nullable=False, default="general")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
