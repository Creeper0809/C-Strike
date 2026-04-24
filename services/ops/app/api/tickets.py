"""티켓 관리 API 라우터 --- 이의 제기/위반 신고 티켓 CRUD 및 메시징."""

from uuid import UUID as PyUUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator
from app.models.operator import Operator
from app.models.ticket import Ticket, TicketMessage
from app.schemas.ticket import (
    TicketCreate,
    TicketUpdate,
    TicketResponse,
    TicketMessageCreate,
    TicketMessageResponse,
)
from app.utils.audit import record_audit

router = APIRouter(tags=["티켓"])


# -- operator 이름 조회 헬퍼 ------------------------------------------------

async def _resolve_operator_names(
    db: AsyncSession, operator_ids: set,
) -> dict:
    if not operator_ids:
        return {}
    result = await db.execute(
        select(Operator.id, Operator.display_name).where(
            Operator.id.in_(operator_ids)
        )
    )
    return {row.id: row.display_name for row in result.all()}


def _enrich_ticket(
    ticket, name_map: dict,
) -> TicketResponse:
    resp = TicketResponse.model_validate(ticket)
    if ticket.assigned_to:
        resp.assigned_to_name = name_map.get(ticket.assigned_to)
    return resp


# -- 헬퍼 ------------------------------------------------------------------

async def _next_ticket_number(db: AsyncSession) -> str:
    """다음 티켓 번호를 생성한다. 형식: CS-2026-001."""
    result = await db.execute(
        select(func.count()).select_from(Ticket)
    )
    current_count = result.scalar() or 0
    return f"CS-2026-{current_count + 1:03d}"


async def _get_ticket_or_404(db: AsyncSession, ticket_id: str) -> Ticket:
    """ID로 티켓을 조회하거나 404를 발생시킨다."""
    result = await db.execute(
        select(Ticket).where(Ticket.id == ticket_id)
    )
    ticket = result.scalar_one_or_none()
    if ticket is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="티켓을 찾을 수 없습니다.",
        )
    return ticket


# -- 엔드포인트 -------------------------------------------------------------

@router.get("/")
async def list_tickets(
    status_filter: str | None = None,
    type: str | None = None,
    priority: str | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """티켓 목록을 페이지네이션으로 조회한다."""
    base_query = select(Ticket)
    count_query = select(func.count()).select_from(Ticket)

    if status_filter:
        base_query = base_query.where(Ticket.status == status_filter)
        count_query = count_query.where(Ticket.status == status_filter)
    if type:
        base_query = base_query.where(Ticket.type == type)
        count_query = count_query.where(Ticket.type == type)
    if priority:
        base_query = base_query.where(Ticket.priority == priority)
        count_query = count_query.where(Ticket.priority == priority)

    offset = (page - 1) * limit
    items_result = await db.execute(
        base_query.order_by(Ticket.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    total_result = await db.execute(count_query)

    tickets = list(items_result.scalars().all())
    total = total_result.scalar() or 0

    operator_ids = {t.assigned_to for t in tickets if t.assigned_to}
    name_map = await _resolve_operator_names(db, operator_ids)
    items = [_enrich_ticket(row, name_map) for row in tickets]

    return {"items": items, "total": total, "page": page, "limit": limit}


@router.post("/", response_model=TicketResponse, status_code=status.HTTP_201_CREATED)
async def create_ticket(
    body: TicketCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """새 티켓을 생성한다. reporter_type은 'operator'로 자동 설정."""
    ticket_number = await _next_ticket_number(db)

    ticket = Ticket(
        ticket_number=ticket_number,
        type=body.type,
        title=body.title,
        description=body.description,
        team_id=body.team_id,
        team_name=body.team_name,
        reporter_type="operator",
        reporter_id=str(current_operator.id),
        status="open",
        priority=body.priority,
    )
    db.add(ticket)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.ticket.create",
        "ticket", ticket.id,
        {"ticket_number": ticket_number, "title": body.title},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(ticket)

    return TicketResponse.model_validate(ticket)


@router.get("/{ticket_id}")
async def get_ticket(
    ticket_id: str,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """티켓 상세 정보와 메시지 목록을 조회한다."""
    ticket = await _get_ticket_or_404(db, ticket_id)

    messages_result = await db.execute(
        select(TicketMessage)
        .where(TicketMessage.ticket_id == ticket_id)
        .order_by(TicketMessage.created_at.asc())
    )
    messages = [
        TicketMessageResponse.model_validate(msg)
        for msg in messages_result.scalars().all()
    ]

    if ticket.assigned_to:
        name_map = await _resolve_operator_names(db, {ticket.assigned_to})
        ticket_data = _enrich_ticket(ticket, name_map).model_dump()
    else:
        ticket_data = TicketResponse.model_validate(ticket).model_dump()
    ticket_data["messages"] = [m.model_dump() for m in messages]

    return ticket_data


@router.patch("/{ticket_id}", response_model=TicketResponse)
async def update_ticket(
    ticket_id: str,
    body: TicketUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """티켓의 상태/담당자/우선순위/해결 내용을 변경한다."""
    ticket = await _get_ticket_or_404(db, ticket_id)

    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="수정할 항목이 없습니다.",
        )

    # 변경 전 값 기록
    changes: dict = {}
    for field, new_value in update_data.items():
        old_value = getattr(ticket, field, None)
        changes[field] = {"old": str(old_value) if old_value else None, "new": str(new_value)}
        setattr(ticket, field, new_value)

    await db.flush()

    await record_audit(
        db, current_operator, "ops.ticket.update",
        "ticket", ticket.id,
        {"changes": changes},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(ticket)

    if ticket.assigned_to:
        name_map = await _resolve_operator_names(db, {ticket.assigned_to})
        return _enrich_ticket(ticket, name_map)
    return TicketResponse.model_validate(ticket)


@router.post("/{ticket_id}/respond", response_model=TicketMessageResponse)
async def respond_to_ticket(
    ticket_id: str,
    body: TicketMessageCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """티켓에 응답 메시지를 추가한다."""
    await _get_ticket_or_404(db, ticket_id)

    message = TicketMessage(
        ticket_id=ticket_id,
        author_id=current_operator.id,
        author_name=current_operator.display_name,
        content=body.content,
        is_internal=body.is_internal,
        synced_to_discord=body.sync_to_discord,
    )
    db.add(message)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.ticket.respond",
        "ticket", ticket_id,
        {"is_internal": body.is_internal},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(message)

    return TicketMessageResponse.model_validate(message)


@router.post("/webhook/discord")
async def discord_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Discord 웹훅 수신 엔드포인트. 인증 없이 접근 가능."""
    body = await request.json()

    ticket_number = body.get("ticket_number")
    content = body.get("content")
    author_name = body.get("author_name", "Discord 사용자")

    if not ticket_number or not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ticket_number와 content는 필수입니다.",
        )

    # ticket_number로 티켓 조회
    result = await db.execute(
        select(Ticket).where(Ticket.ticket_number == ticket_number)
    )
    ticket = result.scalar_one_or_none()
    if ticket is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 ticket_number의 티켓을 찾을 수 없습니다.",
        )

    message = TicketMessage(
        ticket_id=ticket.id,
        author_id=None,
        author_name=author_name,
        content=content,
        is_internal=False,
        synced_to_discord=True,
    )
    db.add(message)
    await db.commit()
    await db.refresh(message)

    return TicketMessageResponse.model_validate(message)
