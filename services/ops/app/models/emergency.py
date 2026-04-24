"""긴급 조치(EmergencyAction) 모델."""

from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class EmergencyAction(Base):
    """긴급 중단/재개 등 비상 조치 이력."""

    __tablename__ = "emergency_actions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    action_type = Column(
        String(30), nullable=False
    )  # halt_all/halt_scoring/halt_service/resume
    target_service_id = Column(UUID(as_uuid=True), ForeignKey("vuln_services.id"))
    reason = Column(Text, nullable=False)
    executed_by = Column(
        UUID(as_uuid=True), ForeignKey("operators.id"), nullable=False
    )
    executed_at = Column(DateTime(timezone=True), server_default=func.now())
    reverted_at = Column(DateTime(timezone=True))
    reverted_by = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
