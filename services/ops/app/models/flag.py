"""플래그(Flag, FlagSubmission) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class Flag(Base):
    """매 라운드 각 팀의 각 서비스에 심어지는 플래그."""

    __tablename__ = "flags"
    __table_args__ = (
        UniqueConstraint("round_id", "team_id", "service_id", name="uq_flags_round_team_service"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    round_id = Column(UUID(as_uuid=True), ForeignKey("scoring_rounds.id", ondelete="CASCADE"), nullable=False)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    service_id = Column(UUID(as_uuid=True), ForeignKey("vuln_services.id", ondelete="RESTRICT"), nullable=False)
    flag_value = Column(String(100), nullable=False, index=True)
    is_active = Column(Boolean, nullable=False, default=True)
    planted_at = Column(DateTime(timezone=True))
    expires_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class FlagSubmission(Base):
    """디스코드 봇을 통한 플래그 제출 기록."""

    __tablename__ = "flag_submissions"
    __table_args__ = (
        CheckConstraint(
            "verdict IN ('correct', 'incorrect', 'expired', 'duplicate', 'own_flag', 'invalid_format')",
            name="chk_flag_submissions_verdict",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    competition_id = Column(UUID(as_uuid=True), ForeignKey("competitions.id", ondelete="RESTRICT"), nullable=False)
    round_id = Column(UUID(as_uuid=True), ForeignKey("scoring_rounds.id", ondelete="SET NULL"))
    submitter_team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    target_team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="SET NULL"))
    service_id = Column(UUID(as_uuid=True), ForeignKey("vuln_services.id", ondelete="SET NULL"))
    submitted_flag = Column(String(100), nullable=False, index=True)
    flag_id = Column(UUID(as_uuid=True), ForeignKey("flags.id", ondelete="SET NULL"))
    verdict = Column(String(20), nullable=False)
    submitter_discord_id = Column(String(50))
    submitted_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
