"""대회(Competition) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class Competition(Base):
    """다회차 대회 정보. 대회별 설정, 팀, 서비스, 점수가 완전히 분리된다."""

    __tablename__ = "competitions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'registration', 'ready', 'running', 'paused', 'finished', 'archived')",
            name="chk_competitions_status",
        ),
        CheckConstraint("scoring_round_interval_seconds > 0", name="chk_competitions_interval"),
        CheckConstraint("max_teams > 0", name="chk_competitions_max_teams"),
        CheckConstraint("max_members_per_team > 0", name="chk_competitions_max_members"),
        CheckConstraint(
            "scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at > scheduled_start_at",
            name="chk_competitions_schedule",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    name = Column(String(200), nullable=False)
    description = Column(Text)
    status = Column(String(20), nullable=False, default="draft")
    scheduled_start_at = Column(DateTime(timezone=True))
    scheduled_end_at = Column(DateTime(timezone=True))
    actual_start_at = Column(DateTime(timezone=True))
    actual_end_at = Column(DateTime(timezone=True))
    scoring_round_interval_seconds = Column(Integer, nullable=False, default=120)
    flag_rotation_enabled = Column(Boolean, nullable=False, default=True)
    max_teams = Column(Integer, nullable=False, default=20)
    max_members_per_team = Column(Integer, nullable=False, default=8)
    network_participant_subnet = Column(String(50), nullable=False, default="10.10.0.0/16")
    network_ops_subnet = Column(String(50), nullable=False, default="10.20.0.0/16")
    created_by = Column(UUID(as_uuid=True), ForeignKey("operators.id", ondelete="RESTRICT"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
