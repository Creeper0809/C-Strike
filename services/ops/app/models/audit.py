"""운영 감사 로그(OpsAuditLog) 모델."""

from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSON, UUID

from app.database import Base


class OpsAuditLog(Base):
    """운영자 행동 감사 로그. 모든 주요 조작을 기록한다."""

    __tablename__ = "ops_audit_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    actor_id = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
    actor_name = Column(String(100), nullable=False)
    action = Column(String(100), nullable=False)
    target_type = Column(String(50))
    target_id = Column(UUID(as_uuid=True))
    details = Column(JSON)
    ip_address = Column(String(45))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
