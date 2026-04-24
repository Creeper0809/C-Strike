"""SLA 체크(SlaCheck) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class SlaCheck(Base):
    """매 라운드 각 팀의 각 서비스에 대한 SLA 헬스 체크 결과."""

    __tablename__ = "sla_checks"
    __table_args__ = (
        UniqueConstraint("round_id", "team_id", "service_id", name="uq_sla_checks_round_team_service"),
        CheckConstraint(
            "check_type IN ('http_get', 'tcp_connect', 'custom_script')",
            name="chk_sla_checks_type",
        ),
        CheckConstraint("response_time_ms IS NULL OR response_time_ms >= 0", name="chk_sla_checks_response_time"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    round_id = Column(UUID(as_uuid=True), ForeignKey("scoring_rounds.id", ondelete="CASCADE"), nullable=False)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    service_id = Column(UUID(as_uuid=True), ForeignKey("vuln_services.id", ondelete="RESTRICT"), nullable=False)
    team_service_id = Column(UUID(as_uuid=True), ForeignKey("team_services.id", ondelete="CASCADE"), nullable=False)
    check_type = Column(String(30), nullable=False)
    is_up = Column(Boolean, nullable=False)
    response_time_ms = Column(Integer)
    error_message = Column(Text)
    checked_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
