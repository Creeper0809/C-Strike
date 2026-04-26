"""배포 파이프라인 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class DeployCreate(BaseModel):
    service_id: str
    scheduled_for: datetime | None = None


class DeployStageResponse(BaseModel):
    id: UUID
    stage_name: str
    stage_order: int
    status: str
    started_at: datetime | None = None
    completed_at: datetime | None = None
    log_output: str | None = None
    error_detail: str | None = None
    model_config = {"from_attributes": True}


class DeployPipelineResponse(BaseModel):
    id: UUID
    service_id: UUID
    triggered_by: UUID
    triggered_by_name: str | None = None
    service_name: str | None = None
    status: str
    current_stage: str | None = None
    scheduled_for: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error_detail: str | None = None
    rollback_of: UUID | None = None
    created_at: datetime | None = None
    stages: list[DeployStageResponse] = []
    model_config = {"from_attributes": True}


class PipelineListResponse(BaseModel):
    """파이프라인 목록용 -- stages 제외."""

    id: UUID
    service_id: UUID
    triggered_by: UUID
    triggered_by_name: str | None = None
    service_name: str | None = None
    status: str
    current_stage: str | None = None
    scheduled_for: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime | None = None
    model_config = {"from_attributes": True}
