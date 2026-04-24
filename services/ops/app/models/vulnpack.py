"""취약점팩 스케줄(VulnpackSchedule) 모델."""

from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID

from app.database import Base


class VulnpackSchedule(Base):
    """취약점팩 배포 스케줄. 대회 중 시간차로 공개되는 서비스 묶음."""

    __tablename__ = "vulnpack_schedules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    pack_number = Column(Integer, nullable=False)  # 1~5
    label = Column(String(100))
    service_ids = Column(ARRAY(UUID(as_uuid=True)), nullable=False)
    scheduled_offset_minutes = Column(Integer, nullable=False)  # 0/120/240/360/480
    actual_release_at = Column(DateTime(timezone=True))
    status = Column(String(20), default="scheduled")  # scheduled/released/cancelled
    released_by = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
    competition_id = Column(UUID(as_uuid=True), ForeignKey("competitions.id", ondelete="SET NULL"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
