"""대회 설정(CompetitionConfig) 모델."""

from sqlalchemy import Column, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSON, UUID

from app.database import Base


class CompetitionConfig(Base):
    """대회 운영 설정 키-값 저장소."""

    __tablename__ = "competition_config"

    key = Column(String(100), primary_key=True)
    value = Column(JSON, nullable=False, default=dict)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
    competition_id = Column(UUID(as_uuid=True), ForeignKey("competitions.id", ondelete="SET NULL"))
    updated_at = Column(DateTime(timezone=True), server_default=func.now())
