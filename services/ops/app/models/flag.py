"""플래그(Flag, FlagSubmission) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class Flag(Base):
    """매 라운드 각 팀의 각 서비스에 심어지는 플래그."""

    __tablename__ = "flags"
    __table_args__ = (
        UniqueConstraint("round_id", "team_id", "service_id", "slot_key", name="uq_flags_round_team_service_slot"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    round_id = Column(UUID(as_uuid=True), ForeignKey("scoring_rounds.id", ondelete="CASCADE"), nullable=False)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    service_id = Column(UUID(as_uuid=True), ForeignKey("vuln_services.id", ondelete="RESTRICT"), nullable=False)
    slot_key = Column(String(64), nullable=False, default="primary")
    slot_label = Column(String(100), nullable=False, default="기본 플래그")
    flag_filename = Column(String(255), nullable=False, default="flag.txt")
    point_value = Column(Integer, nullable=False, default=100)
    flag_value = Column(String(255), nullable=False, index=True)
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
    slot_key = Column(String(64))
    slot_label = Column(String(100))
    points_awarded = Column(Integer)
    submitted_flag = Column(String(255), nullable=False, index=True)
    flag_id = Column(UUID(as_uuid=True), ForeignKey("flags.id", ondelete="SET NULL"))
    verdict = Column(String(20), nullable=False)
    submitter_discord_id = Column(String(50))
    submitted_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
