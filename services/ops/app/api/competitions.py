"""대회 관리 API 라우터 — CRUD + 상태 전환."""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator, require_role
from app.models.competition import Competition
from app.models.feedback import Feedback
from app.models.flag import Flag, FlagSubmission
from app.models.operator import Operator
from app.models.scoring_round import ScoringRound
from app.models.sla_check import SlaCheck
from app.models.team import Team, TeamMember
from app.models.team_score import TeamScore
from app.models.team_service import TeamService
from app.models.vuln_service import VulnService
from app.schemas.competition import (
    CompetitionCreate,
    CompetitionListItem,
    CompetitionListResponse,
    CompetitionResponse,
    CompetitionUpdate,
    PauseResumeRequest,
    StateTransitionResponse,
)
from app.utils.audit import record_audit

router = APIRouter(tags=["대회 관리"])

EARLY_STATUS_TRANSITIONS = {
    "draft": "registration",
    "registration": "ready",
}

FIELD_ALLOWED_STATUSES: dict[str, set[str]] = {
    "name": {"draft", "registration"},
    "description": {"draft", "registration", "ready", "running", "paused", "finished", "archived"},
    "scheduled_start_at": {"draft", "registration", "ready"},
    "scheduled_end_at": {"draft", "registration", "ready"},
    "scoring_round_interval_seconds": {"draft", "registration", "ready", "running", "paused", "finished", "archived"},
    "max_teams": {"draft", "registration"},
    "max_members_per_team": {"draft", "registration"},
    "flag_rotation_enabled": {"draft", "registration", "ready"},
}

ALL_VALID_STATUSES = {"draft", "registration", "ready", "running", "paused", "finished", "archived"}


async def _get_competition_or_404(db: AsyncSession, competition_id: UUID) -> Competition:
    result = await db.execute(
        select(Competition).where(Competition.id == competition_id)
    )
    competition = result.scalar_one_or_none()
    if competition is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="대회를 찾을 수 없습니다.",
        )
    return competition


async def _get_operator_name(db: AsyncSession, operator_id: UUID) -> str | None:
    result = await db.execute(
        select(Operator.display_name).where(Operator.id == operator_id)
    )
    return result.scalar_one_or_none()


async def _get_team_count(db: AsyncSession, competition_id: UUID) -> int:
    result = await db.execute(
        select(func.count()).select_from(Team).where(Team.competition_id == competition_id)
    )
    return result.scalar_one()


async def _get_current_round(db: AsyncSession, competition_id: UUID) -> int:
    result = await db.execute(
        select(func.max(ScoringRound.round_number)).where(
            ScoringRound.competition_id == competition_id
        )
    )
    return result.scalar_one() or 0


async def _to_response(db: AsyncSession, comp: Competition) -> CompetitionResponse:
    creator_name = await _get_operator_name(db, comp.created_by)
    team_count = await _get_team_count(db, comp.id)
    current_round = await _get_current_round(db, comp.id)
    resp = CompetitionResponse.model_validate(comp)
    resp.created_by_name = creator_name
    resp.team_count = team_count
    resp.current_round = current_round
    return resp


async def _check_name_unique(db: AsyncSession, name: str, exclude_id: UUID | None = None) -> None:
    query = select(Competition.id).where(Competition.name == name)
    if exclude_id:
        query = query.where(Competition.id != exclude_id)
    result = await db.execute(query)
    if result.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="같은 이름의 대회가 이미 존재합니다.",
        )


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_competition(
    body: CompetitionCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> CompetitionResponse:
    await _check_name_unique(db, body.name)
    if body.scheduled_start_at and body.scheduled_end_at:
        if body.scheduled_end_at <= body.scheduled_start_at:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="종료 시각이 시작 시각 이전입니다.")

    competition = Competition(
        name=body.name,
        description=body.description,
        scheduled_start_at=body.scheduled_start_at,
        scheduled_end_at=body.scheduled_end_at,
        scoring_round_interval_seconds=body.scoring_round_interval_seconds,
        max_teams=body.max_teams,
        max_members_per_team=body.max_members_per_team,
        network_participant_subnet=body.network_participant_subnet,
        network_ops_subnet=body.network_ops_subnet,
        created_by=current_operator.id,
    )
    db.add(competition)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.competition.create",
        target_type="competition", target_id=competition.id,
        details={"name": body.name},
        ip_address=request.client.host if request.client else None,
    )
    return await _to_response(db, competition)


@router.get("/")
async def list_competitions(
    status_filter: str | None = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> CompetitionListResponse:
    if status_filter and status_filter not in ALL_VALID_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"잘못된 status 값입니다. 허용: {', '.join(sorted(ALL_VALID_STATUSES))}",
        )

    base_query = select(Competition)
    count_query = select(func.count()).select_from(Competition)
    if status_filter:
        base_query = base_query.where(Competition.status == status_filter)
        count_query = count_query.where(Competition.status == status_filter)

    total = (await db.execute(count_query)).scalar_one()
    offset = (page - 1) * size
    result = await db.execute(
        base_query.order_by(Competition.created_at.desc()).offset(offset).limit(size)
    )
    competitions = result.scalars().all()
    items = [CompetitionListItem.model_validate(c) for c in competitions]
    return CompetitionListResponse(items=items, total=total, page=page, size=size)


@router.get("/{competition_id}")
async def get_competition(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> CompetitionResponse:
    comp = await _get_competition_or_404(db, competition_id)
    return await _to_response(db, comp)


@router.patch("/{competition_id}")
async def update_competition(
    competition_id: UUID,
    body: CompetitionUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> CompetitionResponse:
    comp = await _get_competition_or_404(db, competition_id)
    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="수정할 항목이 없습니다.")

    if "status" in update_data:
        new_status = update_data.pop("status")
        expected_next = EARLY_STATUS_TRANSITIONS.get(comp.status)
        if expected_next is None or new_status != expected_next:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"현재 상태({comp.status})에서 {new_status}로 전환할 수 없습니다.",
            )
        comp.status = new_status

    for field_name, value in update_data.items():
        allowed_statuses = FIELD_ALLOWED_STATUSES.get(field_name)
        if allowed_statuses is None:
            continue
        if comp.status not in allowed_statuses:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"현재 상태({comp.status})에서 {field_name} 필드를 수정할 수 없습니다.",
            )
        setattr(comp, field_name, value)

    if "name" in update_data:
        await _check_name_unique(db, comp.name, exclude_id=comp.id)

    if comp.scheduled_start_at and comp.scheduled_end_at:
        if comp.scheduled_end_at <= comp.scheduled_start_at:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="종료 시각이 시작 시각 이전입니다.")

    comp.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.competition.update",
        target_type="competition", target_id=comp.id,
        details={"changed_fields": list(body.model_dump(exclude_unset=True).keys())},
        ip_address=request.client.host if request.client else None,
    )
    return await _to_response(db, comp)


@router.post("/{competition_id}/start")
async def start_competition(
    competition_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> StateTransitionResponse:
    comp = await _get_competition_or_404(db, competition_id)
    if comp.status != "ready":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"현재 상태가 ready가 아니므로 시작할 수 없습니다. (현재: {comp.status})")

    approved_teams = await db.execute(
        select(func.count()).select_from(Team).where(Team.competition_id == competition_id, Team.status == "approved")
    )
    if approved_teams.scalar_one() == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="승인된 팀이 없습니다. 최소 1개 팀을 승인해주세요.")

    active_services = await db.execute(
        select(func.count()).select_from(VulnService).where(VulnService.competition_id == competition_id, VulnService.status == "active")
    )
    if active_services.scalar_one() == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="활성화된 서비스가 없습니다. 최소 1개 서비스를 활성화해주세요.")

    now = datetime.now(timezone.utc)
    comp.status = "running"
    comp.actual_start_at = now
    comp.updated_at = now
    await db.flush()

    await record_audit(db, current_operator, "ops.competition.start", target_type="competition", target_id=comp.id, ip_address=request.client.host if request.client else None)
    return StateTransitionResponse(id=comp.id, status="running", actual_start_at=comp.actual_start_at, message="대회가 시작되었습니다.")


@router.post("/{competition_id}/pause")
async def pause_competition(
    competition_id: UUID,
    body: PauseResumeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> StateTransitionResponse:
    comp = await _get_competition_or_404(db, competition_id)
    if comp.status != "running":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"현재 상태가 running이 아니므로 일시중단할 수 없습니다. (현재: {comp.status})")

    comp.status = "paused"
    comp.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(db, current_operator, "ops.competition.pause", target_type="competition", target_id=comp.id, details={"reason": body.reason}, ip_address=request.client.host if request.client else None)
    return StateTransitionResponse(id=comp.id, status="paused", message="대회가 일시중단되었습니다.", reason=body.reason)


@router.post("/{competition_id}/resume")
async def resume_competition(
    competition_id: UUID,
    body: PauseResumeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> StateTransitionResponse:
    comp = await _get_competition_or_404(db, competition_id)
    if comp.status != "paused":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"현재 상태가 paused가 아니므로 재개할 수 없습니다. (현재: {comp.status})")

    comp.status = "running"
    comp.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(db, current_operator, "ops.competition.resume", target_type="competition", target_id=comp.id, details={"reason": body.reason}, ip_address=request.client.host if request.client else None)
    return StateTransitionResponse(id=comp.id, status="running", message="대회가 재개되었습니다.", reason=body.reason)


@router.post("/{competition_id}/finish")
async def finish_competition(
    competition_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> StateTransitionResponse:
    comp = await _get_competition_or_404(db, competition_id)
    if comp.status != "running":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"현재 상태가 running이 아니므로 종료할 수 없습니다. (현재: {comp.status})")

    now = datetime.now(timezone.utc)
    comp.status = "finished"
    comp.actual_end_at = now
    comp.updated_at = now
    await db.flush()

    total_rounds = await _get_current_round(db, comp.id)
    approved_team_count = (await db.execute(
        select(func.count()).select_from(Team).where(Team.competition_id == competition_id, Team.status == "approved")
    )).scalar_one()

    await record_audit(db, current_operator, "ops.competition.finish", target_type="competition", target_id=comp.id, details={"total_rounds": total_rounds}, ip_address=request.client.host if request.client else None)
    return StateTransitionResponse(id=comp.id, status="finished", actual_end_at=comp.actual_end_at, message="대회가 종료되었습니다.", total_rounds=total_rounds, final_rankings_count=approved_team_count)


@router.post("/{competition_id}/archive")
async def archive_competition(
    competition_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> StateTransitionResponse:
    comp = await _get_competition_or_404(db, competition_id)
    if comp.status != "finished":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"현재 상태가 finished가 아니므로 아카이브할 수 없습니다. (현재: {comp.status})")

    comp.status = "archived"
    comp.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(db, current_operator, "ops.competition.archive", target_type="competition", target_id=comp.id, ip_address=request.client.host if request.client else None)
    return StateTransitionResponse(id=comp.id, status="archived", message="대회가 아카이브되었습니다.")


DELETABLE_STATUSES = {"draft", "registration", "ready", "archived"}


@router.delete("/{competition_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_competition(
    competition_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> None:
    """draft, registration, ready, archived 상태의 대회를 삭제한다."""
    comp = await _get_competition_or_404(db, competition_id)
    if comp.status not in DELETABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="진행 중이거나 종료된 대회는 삭제할 수 없습니다. (draft, registration, ready, archived 상태에서만 삭제 가능)",
        )

    comp_name = comp.name
    await record_audit(
        db, current_operator, "ops.competition.delete",
        target_type="competition", target_id=comp.id,
        details={"name": comp_name, "status_at_delete": comp.status},
        ip_address=request.client.host if request.client else None,
    )

    # FK 순서에 따라 연관 데이터를 먼저 삭제
    team_ids_q = select(Team.id).where(Team.competition_id == competition_id)
    round_ids_q = select(ScoringRound.id).where(ScoringRound.competition_id == competition_id)

    await db.execute(Feedback.__table__.delete().where(Feedback.team_id.in_(team_ids_q)))
    await db.execute(SlaCheck.__table__.delete().where(SlaCheck.team_id.in_(team_ids_q)))
    await db.execute(FlagSubmission.__table__.delete().where(FlagSubmission.competition_id == competition_id))
    await db.execute(Flag.__table__.delete().where(Flag.round_id.in_(round_ids_q)))
    await db.execute(TeamScore.__table__.delete().where(TeamScore.round_id.in_(round_ids_q)))
    await db.execute(ScoringRound.__table__.delete().where(ScoringRound.competition_id == competition_id))
    await db.execute(TeamService.__table__.delete().where(TeamService.team_id.in_(team_ids_q)))
    await db.execute(TeamMember.__table__.delete().where(TeamMember.team_id.in_(team_ids_q)))
    await db.execute(Team.__table__.delete().where(Team.competition_id == competition_id))
    await db.execute(VulnService.__table__.delete().where(VulnService.competition_id == competition_id))

    await db.delete(comp)
    await db.flush()
