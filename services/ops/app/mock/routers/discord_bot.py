"""Mock Discord 봇 라우터."""
import uuid
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.mock.scenarios import get_data
from app.mock.state import now_iso

router = APIRouter()


class AnnounceRequest(BaseModel):
    channel: str = "general"
    message: str = ""


class IncidentRequest(BaseModel):
    severity: str = "warning"
    title: str = ""
    details: str = ""


class TicketResponse(BaseModel):
    message: str = ""


@router.post("/announce")
async def announce(body: AnnounceRequest):
    msg_id = f"msg-{uuid.uuid4().hex[:8]}"
    return {"success": True, "message_id": msg_id}


@router.post("/notify-incident")
async def notify_incident(body: IncidentRequest):
    msg_id = f"msg-{uuid.uuid4().hex[:8]}"
    return {"success": True, "message_id": msg_id}


@router.get("/tickets")
async def list_tickets(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["discord"]["tickets"]


@router.post("/tickets/{ticket_id}/respond")
async def respond_ticket(ticket_id: str, body: TicketResponse):
    msg_id = f"msg-{uuid.uuid4().hex[:8]}"
    return {"success": True, "message_id": msg_id}


@router.post("/tickets/{ticket_id}/close")
async def close_ticket(ticket_id: str):
    return {"success": True}


@router.get("/health")
async def health(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["discord"]["health"]
