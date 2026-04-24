"""감사 로그(AuditLog) 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class AuditLogResponse(BaseModel):
    id: UUID
    actor_id: UUID | None = None
    actor_name: str
    action: str
    target_type: str | None = None
    target_id: UUID | None = None
    details: dict | None = None
    ip_address: str | None = None
    created_at: datetime | None = None
    model_config = {"from_attributes": True}
