"""팀 관리 API 라우터 — 목록/상세/수정/승인/실격/삭제/생성/팀원/서비스."""

import logging
import secrets
import string
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator, require_role
from app.external import discord_client
from app.models.competition import Competition
from app.models.team import Team, TeamMember
from app.models.team_service import TeamService
from app.models.vuln_service import VulnService
from app.models.operator import Operator
from app.schemas.team import (
    TeamApproveResponse,
    TeamCreate,
    TeamDisqualifyRequest,
    TeamDisqualifyResponse,
    TeamListItem,
    TeamListResponse,
    TeamMemberItem,
    TeamMemberListResponse,
    TeamResponse,
    TeamServiceItem,
    TeamServiceListResponse,
    TeamUpdate,
)
from app.utils.audit import record_audit
from app.utils.crypto import encrypt_password
from app.utils.events import publish_event

router = APIRouter(tags=["팀 관리"])
logger = logging.getLogger("ops.teams")

ALL_VALID_TEAM_STATUSES = {"pending", "approved", "active", "disqualified", "withdrawn"}


# ── 헬퍼 함수 ────────────────────────────────────────────

async def _get_competition_or_404(db: AsyncSession, competition_id: UUID) -> Competition:
    """대회 존재 여부를 확인하고 반환한다."""
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


async def _get_team_or_404(
    db: AsyncSession, competition_id: UUID, team_id: UUID,
) -> Team:
    """대회에 속한 팀 존재 여부를 확인하고 반환한다."""
    # 대회 먼저 검증
    await _get_competition_or_404(db, competition_id)

    result = await db.execute(
        select(Team).where(
            Team.id == team_id,
            Team.competition_id == competition_id,
        )
    )
    team = result.scalar_one_or_none()
    if team is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="팀을 찾을 수 없습니다.",
        )
    return team


def _generate_team_code(name: str) -> str:
    """팀명 기반 팀 코드 생성. 예: 'CyberPhoenix' → 'CP-A3F2'."""
    initials = "".join(c for c in name if c.isupper())[:2]
    if len(initials) < 2:
        initials = name[:2].upper()
    suffix = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    return f"{initials}-{suffix}"


# ── 엔드포인트 ───────────────────────────────────────────

@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_team(
    competition_id: UUID,
    body: TeamCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamResponse:
    """운영포털에서 팀을 생성한다.

    captain_discord_id는 'UNASSIGNED'로 설정되며,
    디스코드 연동 후 실제 값으로 PATCH 업데이트한다.
    """
    competition = await _get_competition_or_404(db, competition_id)

    # 최대 팀 수 초과 검증
    team_count = (await db.execute(
        select(func.count()).select_from(Team).where(
            Team.competition_id == competition_id
        )
    )).scalar_one()
    if team_count >= competition.max_teams:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"대회 최대 팀 수({competition.max_teams})를 초과했습니다.",
        )

    # 같은 대회 내 팀명 중복 검증
    name_conflict = await db.execute(
        select(Team.id).where(
            Team.competition_id == competition_id,
            Team.name == body.name,
        )
    )
    if name_conflict.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="같은 대회에 동일한 팀명이 이미 존재합니다.",
        )

    # 서브넷 중복 검증 (값이 있을 때만)
    if body.subnet:
        subnet_conflict = await db.execute(
            select(Team.id).where(
                Team.competition_id == competition_id,
                Team.subnet == body.subnet,
            )
        )
        if subnet_conflict.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="해당 VPN 대역은 이미 다른 팀이 사용 중입니다.",
            )

    # team_code 생성 (충돌 시 최대 10회 재시도)
    for _ in range(10):
        team_code = _generate_team_code(body.name)
        dup = (await db.execute(
            select(Team.id).where(
                Team.competition_id == competition_id,
                Team.team_code == team_code,
            )
        )).scalar_one_or_none()
        if dup is None:
            break
    else:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="팀 코드 생성에 실패했습니다. 다시 시도해주세요.",
        )

    team = Team(
        competition_id=competition_id,
        name=body.name,
        team_code=team_code,
        captain_discord_id="UNASSIGNED",
        subnet=body.subnet,
        gateway_ip=body.gateway_ip,
        vpn_profile_issued=False,
        status="pending",
        ssh_port=body.ssh_port,
        ssh_user=body.ssh_user,
        ssh_password=encrypt_password(body.ssh_password) if body.ssh_password else None,
    )
    db.add(team)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.team.create",
        target_type="team", target_id=team.id,
        details={"team_name": team.name, "team_code": team_code},
        ip_address=request.client.host if request.client else None,
    )

    # Discord 봇에 역할 생성 요청 (실패해도 팀 생성은 성공시킴 — 견고성)
    # 봇 오프라인/오류 시 경고 로그만 남기고 관리자가 나중에 discord_role_id를 수동 입력한다.
    try:
        role_result = await discord_client.create_team_role(team.name)
        team.discord_role_id = role_result.get("role_id")
        await db.flush()
        await db.refresh(team)
    except Exception as exc:
        logger.warning(
            "Discord 팀 역할 생성 실패 (team_name=%s): %s. "
            "관리자가 수동으로 discord_role_id 입력 필요.",
            team.name, exc,
        )

    await publish_event("team:created", {
        "team_id": str(team.id),
        "team_name": team.name,
        "team_code": team.team_code,
        "competition_id": str(competition_id),
        "discord_role_id": team.discord_role_id,
    })

    resp = TeamResponse.model_validate(team)
    resp.ssh_configured = bool(team.ssh_user and team.ssh_password)
    return resp


@router.get("/")
async def list_teams(
    competition_id: UUID,
    status_filter: str | None = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> TeamListResponse:
    """대회에 등록된 팀 목록을 조회한다."""
    await _get_competition_or_404(db, competition_id)

    if status_filter and status_filter not in ALL_VALID_TEAM_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"잘못된 status 값입니다. 허용: {', '.join(sorted(ALL_VALID_TEAM_STATUSES))}",
        )

    base_query = select(Team).where(Team.competition_id == competition_id)
    count_query = select(func.count()).select_from(Team).where(
        Team.competition_id == competition_id
    )
    if status_filter:
        base_query = base_query.where(Team.status == status_filter)
        count_query = count_query.where(Team.status == status_filter)

    total = (await db.execute(count_query)).scalar_one()
    offset = (page - 1) * size
    result = await db.execute(
        base_query.order_by(Team.registered_at.desc()).offset(offset).limit(size)
    )
    teams = result.scalars().all()

    # member_count 일괄 조회
    team_ids = [t.id for t in teams]
    member_counts: dict[UUID, int] = {}
    if team_ids:
        mc_result = await db.execute(
            select(TeamMember.team_id, func.count().label("cnt"))
            .where(TeamMember.team_id.in_(team_ids))
            .group_by(TeamMember.team_id)
        )
        member_counts = {row.team_id: row.cnt for row in mc_result}

    items: list[TeamListItem] = []
    for t in teams:
        item = TeamListItem.model_validate(t)
        item.member_count = member_counts.get(t.id, 0)
        item.ssh_configured = bool(t.ssh_user and t.ssh_password)
        items.append(item)

    return TeamListResponse(items=items, total=total, page=page, size=size)


@router.get("/{team_id}")
async def get_team(
    competition_id: UUID,
    team_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> TeamResponse:
    """팀 상세 정보를 조회한다."""
    team = await _get_team_or_404(db, competition_id, team_id)
    resp = TeamResponse.model_validate(team)
    resp.ssh_configured = bool(team.ssh_user and team.ssh_password)
    return resp


@router.patch("/{team_id}")
async def update_team(
    competition_id: UUID,
    team_id: UUID,
    body: TeamUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamResponse:
    """팀 정보를 수정한다 (서브넷, 게이트웨이 IP, VPN 발급 상태, 디스코드 역할 ID)."""
    team = await _get_team_or_404(db, competition_id, team_id)
    update_data = body.model_dump(exclude_unset=True)

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="수정할 항목이 없습니다.",
        )

    # 팀명 충돌 검사 (같은 대회 내 다른 팀이 동일 이름을 사용하는지)
    if "name" in update_data and update_data["name"] is not None:
        name_conflict = await db.execute(
            select(Team.id).where(
                Team.competition_id == competition_id,
                Team.name == update_data["name"],
                Team.id != team_id,
            )
        )
        if name_conflict.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="해당 팀명은 이미 다른 팀이 사용 중입니다.",
            )

    # 서브넷 충돌 검사 (같은 대회 내 다른 팀이 동일 서브넷을 사용하는지)
    if "subnet" in update_data and update_data["subnet"] is not None:
        conflict = await db.execute(
            select(Team.id).where(
                Team.competition_id == competition_id,
                Team.subnet == update_data["subnet"],
                Team.id != team_id,
            )
        )
        if conflict.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="해당 서브넷은 이미 다른 팀이 사용 중입니다.",
            )

    # SSH 비밀번호는 암호화하여 저장
    if "ssh_password" in update_data and update_data["ssh_password"] is not None:
        update_data["ssh_password"] = encrypt_password(update_data["ssh_password"])

    for field_name, value in update_data.items():
        setattr(team, field_name, value)

    team.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.team.update",
        target_type="team", target_id=team.id,
        details={"changed_fields": list(update_data.keys())},
        ip_address=request.client.host if request.client else None,
    )
    resp = TeamResponse.model_validate(team)
    resp.ssh_configured = bool(team.ssh_user and team.ssh_password)
    return resp


@router.post("/{team_id}/approve")
async def approve_team(
    competition_id: UUID,
    team_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamApproveResponse:
    """팀을 승인한다. pending -> approved 전환."""
    team = await _get_team_or_404(db, competition_id, team_id)

    if team.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"현재 상태가 pending이 아니므로 승인할 수 없습니다. (현재: {team.status})",
        )

    # 대회 최대 팀 수 검증
    competition = await _get_competition_or_404(db, competition_id)
    approved_count = (await db.execute(
        select(func.count()).select_from(Team).where(
            Team.competition_id == competition_id,
            Team.status.in_(["approved", "active"]),
        )
    )).scalar_one()

    if approved_count >= competition.max_teams:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"대회 최대 팀 수({competition.max_teams})를 초과할 수 없습니다.",
        )

    now = datetime.now(timezone.utc)
    team.status = "approved"
    team.approved_at = now
    team.updated_at = now
    await db.flush()

    await record_audit(
        db, current_operator, "ops.team.approve",
        target_type="team", target_id=team.id,
        details={"team_name": team.name},
        ip_address=request.client.host if request.client else None,
    )
    return TeamApproveResponse(
        id=team.id,
        name=team.name,
        status="approved",
        approved_at=team.approved_at,
        message="팀이 승인되었습니다.",
    )


@router.post("/{team_id}/disqualify")
async def disqualify_team(
    competition_id: UUID,
    team_id: UUID,
    body: TeamDisqualifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamDisqualifyResponse:
    """팀을 실격 처리한다. active -> disqualified 전환."""
    team = await _get_team_or_404(db, competition_id, team_id)

    if team.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"현재 상태가 active가 아니므로 실격 처리할 수 없습니다. (현재: {team.status})",
        )

    team.status = "disqualified"
    team.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.team.disqualify",
        target_type="team", target_id=team.id,
        details={"team_name": team.name, "reason": body.reason},
        ip_address=request.client.host if request.client else None,
    )
    return TeamDisqualifyResponse(
        id=team.id,
        name=team.name,
        status="disqualified",
        message="팀이 실격 처리되었습니다.",
        reason=body.reason,
    )


@router.get("/{team_id}/members")
async def list_team_members(
    competition_id: UUID,
    team_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> TeamMemberListResponse:
    """팀원 목록을 조회한다."""
    team = await _get_team_or_404(db, competition_id, team_id)

    result = await db.execute(
        select(TeamMember)
        .where(TeamMember.team_id == team_id)
        .order_by(TeamMember.joined_at.asc())
    )
    members = result.scalars().all()
    items = [TeamMemberItem.model_validate(m) for m in members]

    return TeamMemberListResponse(
        team_id=team.id,
        team_name=team.name,
        items=items,
        total=len(items),
    )


@router.get("/{team_id}/services")
async def list_team_services(
    competition_id: UUID,
    team_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> TeamServiceListResponse:
    """팀에 배포된 서비스 인스턴스 목록을 조회한다."""
    team = await _get_team_or_404(db, competition_id, team_id)

    # TeamService + VulnService JOIN으로 service_name 가져오기
    result = await db.execute(
        select(TeamService, VulnService.name.label("service_name"))
        .join(VulnService, TeamService.service_id == VulnService.id)
        .where(TeamService.team_id == team_id)
        .order_by(TeamService.created_at.asc())
    )
    rows = result.all()

    items: list[TeamServiceItem] = []
    for ts, service_name in rows:
        item = TeamServiceItem(
            id=ts.id,
            service_id=ts.service_id,
            service_name=service_name,
            host_ip=ts.host_ip,
            port=ts.port,
            container_id=ts.container_id,
            status=ts.status,
            last_health_check_at=ts.last_health_check_at,
            last_health_check_result=ts.last_health_check_result,
        )
        items.append(item)

    return TeamServiceListResponse(
        team_id=team.id,
        team_name=team.name,
        items=items,
        total=len(items),
    )


@router.delete("/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_team(
    competition_id: UUID,
    team_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
):
    """팀을 영구 삭제한다 (모든 상태에서 가능).

    디스코드 봇 등록 모델 특성상 잘못 등록되거나 탈퇴한 팀을 정리할
    유일한 수단이다. FK는 team_members/team_services/team_scores/sla_checks/
    flags/flag_submissions 모두 CASCADE로 DB 레벨에서 자동 삭제되며,
    feedbacks는 SET NULL로 익명화 보존된다.

    주의: 팀에 배포된 실제 Docker 컨테이너는 별도 영역(배포 관리)에서
    선행 정리해야 한다. 본 엔드포인트는 운영 포털 DB 레코드만 정리한다.
    """
    team = await _get_team_or_404(db, competition_id, team_id)

    member_count = (await db.execute(
        select(func.count()).select_from(TeamMember).where(TeamMember.team_id == team_id)
    )).scalar_one()
    service_count = (await db.execute(
        select(func.count()).select_from(TeamService).where(TeamService.team_id == team_id)
    )).scalar_one()

    await record_audit(
        db, current_operator, "ops.team.delete",
        target_type="team", target_id=team.id,
        details={
            "team_name": team.name,
            "team_code": team.team_code,
            "status_at_delete": team.status,
            "member_count": member_count,
            "service_count": service_count,
        },
        ip_address=request.client.host if request.client else None,
    )

    # Discord 봇에 역할 삭제 요청 (실패해도 팀 DB 삭제는 진행 — 견고성)
    # discord_role_id가 없는(= 봇 연동 실패로 역할이 생성되지 않았던) 팀은 호출 자체를 건너뛴다.
    if team.discord_role_id:
        try:
            await discord_client.delete_team_role(team.discord_role_id)
        except Exception as exc:
            logger.warning(
                "Discord 팀 역할 삭제 실패 (team_name=%s, role_id=%s): %s. "
                "관리자가 Discord에서 수동으로 역할 정리 필요.",
                team.name, team.discord_role_id, exc,
            )

    await db.delete(team)
    await db.commit()
