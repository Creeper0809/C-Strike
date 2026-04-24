"""배포 파이프라인(DeployPipeline, DeployStage) 모델."""

from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class DeployPipeline(Base):
    """서비스 배포 파이프라인. 단계별 진행 상태를 추적한다."""

    __tablename__ = "deploy_pipelines"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    service_id = Column(
        UUID(as_uuid=True), ForeignKey("vuln_services.id"), nullable=False
    )
    triggered_by = Column(
        UUID(as_uuid=True), ForeignKey("operators.id"), nullable=False
    )
    status = Column(String(20), nullable=False, default="pending")
    current_stage = Column(String(30))
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    error_detail = Column(Text)
    rollback_of = Column(UUID(as_uuid=True), ForeignKey("deploy_pipelines.id"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class DeployStage(Base):
    """배포 파이프라인의 개별 단계."""

    __tablename__ = "deploy_stages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    pipeline_id = Column(
        UUID(as_uuid=True), ForeignKey("deploy_pipelines.id"), nullable=False
    )
    stage_name = Column(
        String(30), nullable=False
    )  # register/approve/verify/activate/confirm
    stage_order = Column(Integer, nullable=False)
    status = Column(String(20), default="pending")
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    log_output = Column(Text)
    error_detail = Column(Text)
