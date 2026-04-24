"""티켓(Ticket, TicketMessage) 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class TicketCreate(BaseModel):
    type: str  # dispute / violation
    title: str
    description: str
    team_id: str | None = None
    team_name: str | None = None
    priority: str = "medium"


class TicketUpdate(BaseModel):
    status: str | None = None
    priority: str | None = None
    assigned_to: str | None = None
    resolution: str | None = None


class TicketResponse(BaseModel):
    id: UUID
    ticket_number: str
    type: str
    title: str
    description: str
    team_id: str | None = None
    team_name: str | None = None
    reporter_type: str
    status: str
    priority: str
    assigned_to: UUID | None = None
    assigned_to_name: str | None = None
    resolution: str | None = None
    discord_ticket_id: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    model_config = {"from_attributes": True}


class TicketMessageCreate(BaseModel):
    content: str
    is_internal: bool = False
    sync_to_discord: bool = False


class TicketMessageResponse(BaseModel):
    id: UUID
    ticket_id: UUID
    author_id: UUID | None = None
    author_name: str
    content: str
    is_internal: bool
    synced_to_discord: bool
    created_at: datetime | None = None
    model_config = {"from_attributes": True}
