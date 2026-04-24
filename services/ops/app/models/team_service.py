"""팀별 서비스 인스턴스(TeamService) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class TeamService(Base):
    """팀에 배포된 취약 서비스 인스턴스. vuln_service 하나가 팀 수만큼 복제된다."""

    __tablename__ = "team_services"
    __table_args__ = (
        UniqueConstraint("team_id", "service_id", name="uq_team_services_team_service"),
        CheckConstraint(
            "status IN ('provisioning', 'running', 'stopped', 'error', 'destroyed')",
            name="chk_team_services_status",
        ),
        CheckConstraint("port > 0 AND port <= 65535", name="chk_team_services_port"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    service_id = Column(UUID(as_uuid=True), ForeignKey("vuln_services.id", ondelete="RESTRICT"), nullable=False)
    host_ip = Column(String(45), nullable=False)
    port = Column(Integer, nullable=False)
    container_id = Column(String(100))
    status = Column(String(20), nullable=False, default="provisioning")
    last_health_check_at = Column(DateTime(timezone=True))
    last_health_check_result = Column(Boolean)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
