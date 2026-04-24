"""티켓(Ticket, TicketMessage) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class Ticket(Base):
    """이의 제기 및 위반 신고 티켓."""

    __tablename__ = "tickets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    ticket_number = Column(String(20), unique=True, nullable=False)
    type = Column(String(20), nullable=False)  # dispute / violation
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False)
    team_id = Column(String(100))
    team_name = Column(String(100))
    reporter_type = Column(String(20), nullable=False)  # operator/team/discord
    reporter_id = Column(String(100))
    discord_ticket_id = Column(String(50))
    discord_channel_id = Column(String(50))
    status = Column(String(20), default="open")
    priority = Column(String(10), default="medium")
    assigned_to = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
    resolution = Column(Text)
    resolved_by = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
    resolved_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class TicketMessage(Base):
    """티켓 내 메시지. 내부 메모와 디스코드 동기화를 지원한다."""

    __tablename__ = "ticket_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    ticket_id = Column(UUID(as_uuid=True), ForeignKey("tickets.id"), nullable=False)
    author_id = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
    author_name = Column(String(100), nullable=False)
    content = Column(Text, nullable=False)
    is_internal = Column(Boolean, default=False)
    synced_to_discord = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
