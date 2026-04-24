"""팀별 라운드 점수(TeamScore) 모델."""

from uuid import uuid4

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Integer, Numeric, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class TeamScore(Base):
    """매 라운드 채점 결과. 스코어보드의 핵심 데이터 소스."""

    __tablename__ = "team_scores"
    __table_args__ = (
        UniqueConstraint("round_id", "team_id", name="uq_team_scores_round_team"),
        CheckConstraint("attack_score >= 0", name="chk_team_scores_attack"),
        CheckConstraint("defense_score >= 0", name="chk_team_scores_defense"),
        CheckConstraint("bonus_score >= 0", name="chk_team_scores_bonus"),
        CheckConstraint("total_score >= 0", name="chk_team_scores_total"),
        CheckConstraint("sla_score >= 0 AND sla_score <= 1", name="chk_team_scores_sla"),
        CheckConstraint("rank IS NULL OR rank > 0", name="chk_team_scores_rank"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    round_id = Column(UUID(as_uuid=True), ForeignKey("scoring_rounds.id", ondelete="CASCADE"), nullable=False)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    attack_score = Column(Numeric(10, 2), nullable=False, default=0)
    defense_score = Column(Numeric(10, 2), nullable=False, default=0)
    sla_score = Column(Numeric(5, 4), nullable=False, default=0)
    bonus_score = Column(Numeric(10, 2), nullable=False, default=0)
    total_score = Column(Numeric(10, 2), nullable=False, default=0)
    rank = Column(Integer)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
