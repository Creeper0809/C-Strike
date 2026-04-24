"""취약점팩 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class VulnpackCreate(BaseModel):
    pack_number: int  # 1~5
    label: str | None = None
    service_ids: list[str]
    scheduled_offset_minutes: int  # 0/120/240/360/480


class VulnpackUpdate(BaseModel):
    label: str | None = None
    service_ids: list[str] | None = None
    scheduled_offset_minutes: int | None = None


class VulnpackResponse(BaseModel):
    id: UUID
    pack_number: int
    label: str | None = None
    service_ids: list[UUID]
    service_names: dict[str, str] | None = None
    scheduled_offset_minutes: int
    actual_release_at: datetime | None = None
    status: str
    released_by: UUID | None = None
    created_at: datetime | None = None
    model_config = {"from_attributes": True}
