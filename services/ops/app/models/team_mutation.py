"""팀/팀원 변경 작업 실행 로그 및 직렬화 잠금 모델."""

from uuid import uuid4

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSON, UUID

from app.database import Base


class TeamMutation(Base):
    """외부 시스템이 섞인 팀 변경 작업의 실행 상태를 기록한다."""

    __tablename__ = "team_mutations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'completed', 'failed')",
            name="chk_team_mutations_status",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    resource_key = Column(String(191), nullable=False)
    operation_type = Column(String(64), nullable=False)
    status = Column(String(20), nullable=False, default="running")

    competition_id = Column(UUID(as_uuid=True), nullable=True)
    team_id = Column(UUID(as_uuid=True), nullable=True)
    member_id = Column(UUID(as_uuid=True), nullable=True)

    requested_by_operator_id = Column(
        UUID(as_uuid=True),
        ForeignKey("operators.id"),
        nullable=True,
    )
    requested_by_name = Column(String(100), nullable=False)

    payload = Column(JSON, nullable=True)
    result = Column(JSON, nullable=True)
    error_detail = Column(Text, nullable=True)

    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
