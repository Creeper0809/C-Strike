"""채점 라운드(ScoringRound) 모델."""

from uuid import uuid4

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class ScoringRound(Base):
    """채점 엔진이 실행하는 각 라운드의 상태와 진행 기록."""

    __tablename__ = "scoring_rounds"
    __table_args__ = (
        UniqueConstraint("competition_id", "round_number", name="uq_scoring_rounds_comp_number"),
        CheckConstraint(
            "status IN ('scheduled', 'running', 'scoring', 'completed', 'failed', 'cancelled')",
            name="chk_scoring_rounds_status",
        ),
        CheckConstraint("round_number > 0", name="chk_scoring_rounds_number"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    competition_id = Column(UUID(as_uuid=True), ForeignKey("competitions.id", ondelete="RESTRICT"), nullable=False)
    round_number = Column(Integer, nullable=False)
    status = Column(String(20), nullable=False, default="scheduled")
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    flag_plant_completed_at = Column(DateTime(timezone=True))
    sla_check_completed_at = Column(DateTime(timezone=True))
    scoring_completed_at = Column(DateTime(timezone=True))
    error_detail = Column(Text)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
