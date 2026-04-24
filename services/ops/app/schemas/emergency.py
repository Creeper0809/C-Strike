"""비상 통제 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class EmergencyHaltRequest(BaseModel):
    reason: str


class EmergencyHaltServiceRequest(BaseModel):
    reason: str


class EmergencyResumeRequest(BaseModel):
    reason: str


class EmergencyActionResponse(BaseModel):
    id: UUID
    action_type: str
    target_service_id: UUID | None = None
    reason: str
    executed_by: UUID
    executed_by_name: str | None = None
    executed_at: datetime | None = None
    reverted_at: datetime | None = None
    reverted_by: UUID | None = None
    reverted_by_name: str | None = None
    model_config = {"from_attributes": True}


class EmergencyStatusResponse(BaseModel):
    is_halted: bool
    halt_type: str | None = None  # all/scoring/service
    active_actions: list[EmergencyActionResponse] = []
