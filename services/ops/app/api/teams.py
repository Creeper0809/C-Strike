"""팀 관리 API 라우터 — 목록/상세/수정/승인/실격/삭제/생성/팀원/서비스."""

import logging
import secrets
import string
import unicodedata
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator, require_role
from app.external import discord_client
from app.models.competition import Competition
from app.models.discord_member import DiscordGuildMember
from app.models.team import Team, TeamMember
from app.models.team_mutation import TeamMutation
from app.models.team_service import TeamService
from app.models.sla_check import SlaCheck
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
    TeamMemberCreateRequest,
    TeamMemberCreateResponse,
    TeamMemberRemoveResponse,
    TeamMutationItem,
    TeamMutationListResponse,
    TeamMutationRetryResponse,
    TeamResponse,
    TeamSshPasswordRevealResponse,
    TeamServiceHealthcheckLiveResponse,
    TeamServiceItem,
    TeamServiceListResponse,
    TeamUpdate,
)
from app.utils.audit import record_audit
from app.utils.crypto import decrypt_password, encrypt_password
from app.utils.events import publish_event
from app.utils.healthcheck_live import (
    run_basic_http_healthcheck,
    run_basic_tcp_healthcheck,
    run_scenario_healthcheck,
)
from app.utils.network_team_cleanup import (
    NetworkTeamCleanupError,
    cleanup_team_network,
    network_team_delete_enabled,
)
from app.utils.network_team_provision import (
    NetworkTeamProvisionError,
    provision_team_network,
    network_team_provision_enabled,
)
from app.utils.network_team_member_vpn import (
    NetworkTeamMemberVpnError,
    provision_team_member_vpn,
    disable_team_member_vpn,
    network_team_member_vpn_enabled,
)
from app.utils.runtime_team_cleanup import (
    RuntimeTeamCleanupError,
    cleanup_team_runtime,
    runtime_team_cleanup_enabled,
)
from app.utils.team_slots import (
    TeamSlotPoolError,
    allocate_team_slot,
    get_team_slot_pool,
)
from app.utils.team_mutations import (
    TeamMutationConflictError,
    append_team_mutation_warning,
    mark_mutation_completed,
    persist_team_mutation_failed,
    start_team_mutation,
    team_create_resource_key,
    team_resource_key,
)

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


def _preferred_discord_member_name(member: DiscordGuildMember) -> str:
    for candidate in (
        member.display_name,
        member.nick,
        member.global_name,
        member.username,
        member.discord_user_id,
    ):
        normalized = str(candidate or "").strip()
        if normalized:
            return normalized
    return "unknown"


def _generate_team_code(name: str) -> str:
    """팀명 기반 팀 코드 생성. 예: 'CyberPhoenix' → 'CP-A3F2'."""
    initials = "".join(c for c in name if c.isupper() and c.isalnum())[:2]
    if len(initials) < 2:
        initials = "".join(c for c in name.upper() if c.isalnum())[:2]
    if len(initials) < 2:
        initials = (initials + "TM")[:2]
    suffix = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    return f"{initials}-{suffix}"


async def _get_team_member_sequence(
    db: AsyncSession,
    *,
    team_id: UUID,
    member_id: UUID,
) -> int:
    """팀 안에서 해당 팀원의 고정 VPN 순번을 계산한다."""
    member_ids = (
        await db.execute(
            select(TeamMember.id)
            .where(TeamMember.team_id == team_id)
            .order_by(TeamMember.created_at.asc(), TeamMember.id.asc())
        )
    ).scalars().all()
    for index, candidate_id in enumerate(member_ids, start=1):
        if candidate_id == member_id:
            return index
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="팀원 VPN 순번을 계산하지 못했습니다.",
    )


async def _get_team_member_or_404(
    db: AsyncSession,
    *,
    team_id: UUID,
    member_id: UUID,
) -> TeamMember:
    result = await db.execute(
        select(TeamMember).where(
            TeamMember.id == member_id,
            TeamMember.team_id == team_id,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="팀원을 찾을 수 없습니다.",
        )
    return member


async def _get_team_mutation_or_404(
    db: AsyncSession,
    *,
    team_id: UUID,
    mutation_id: UUID,
) -> TeamMutation:
    result = await db.execute(
        select(TeamMutation).where(
            TeamMutation.id == mutation_id,
            TeamMutation.team_id == team_id,
        )
    )
    mutation = result.scalar_one_or_none()
    if mutation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="작업 이력을 찾을 수 없습니다.",
        )
    return mutation


def _is_retryable_mutation(mutation: TeamMutation) -> bool:
    return mutation.status == "failed" and mutation.operation_type in {
        "team.member.add",
        "team.member.remove",
        "team.delete",
    }


def _store_member_vpn_credentials(
    member: TeamMember,
    *,
    vpn_username: str | None,
    vpn_ip: str | None,
    generated_password: str | None,
    updated_at: datetime,
) -> None:
    if vpn_username:
        member.vpn_username = vpn_username
    if vpn_ip:
        member.vpn_ip = vpn_ip
    if generated_password:
        member.vpn_password = encrypt_password(generated_password)
        member.vpn_password_updated_at = updated_at


def _clear_member_vpn_secret(member: TeamMember, *, updated_at: datetime) -> None:
    member.vpn_password = None
    member.vpn_password_updated_at = updated_at


def _sanitize_download_filename_fragment(value: str) -> str:
    ascii_source = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    normalized = "".join(
        character.lower() if character.isalnum() else "-"
        for character in ascii_source.strip()
    )
    while "--" in normalized:
        normalized = normalized.replace("--", "-")
    normalized = normalized.strip("-")
    return normalized or "team"


def _build_team_members_vpn_bundle_text(
    *,
    team: Team,
    generated_at: datetime,
    members: list[dict[str, str]],
    reissued_count: int,
) -> str:
    del generated_at
    del reissued_count
    lines = [
        "# C-STRIKE VPN Access",
        f"team_name={team.name}",
        "profile_file=cyber-ad-team.ovpn",
        "",
    ]

    for index, member in enumerate(members, start=1):
        lines.extend(
            [
                f"[member_{index}]",
                f"name={member['discord_username']}",
                f"vpn_username={member['vpn_username']}",
                f"vpn_password={member['vpn_password']}",
                f"vpn_ip={member['vpn_ip']}",
                "",
            ]
        )

    return "\n".join(lines).strip() + "\n"


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
    try:
        slot_pool = await get_team_slot_pool()
    except TeamSlotPoolError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"팀 슬롯 inventory 조회에 실패했습니다. {exc}",
        ) from exc

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

    auto_allocate_slot = not any([
        (body.subnet or "").strip(),
        (body.gateway_ip or "").strip(),
        (body.ssh_user or "").strip(),
        body.ssh_password,
    ])
    allocated_slot = None
    if auto_allocate_slot and slot_pool:
        allocated_slot = await allocate_team_slot(db, slot_pool=slot_pool)
        if allocated_slot is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="할당 가능한 팀 슬롯이 없습니다. 기존 팀을 삭제하거나 슬롯 풀을 늘려주세요.",
            )

    assigned_subnet = body.subnet.strip() if body.subnet else None
    assigned_gateway_ip = body.gateway_ip.strip() if body.gateway_ip else None
    assigned_ssh_port = body.ssh_port
    assigned_ssh_user = body.ssh_user.strip() if body.ssh_user else None
    assigned_ssh_password = body.ssh_password
    vpn_profile_issued = False

    if allocated_slot is not None:
        assigned_subnet = allocated_slot.subnet
        assigned_gateway_ip = allocated_slot.gateway_ip
        assigned_ssh_port = allocated_slot.ssh_port
        assigned_ssh_user = allocated_slot.ssh_user
        assigned_ssh_password = allocated_slot.ssh_password
        vpn_profile_issued = allocated_slot.vpn_profile_issued

    network_provision_result = None
    if assigned_subnet and network_team_provision_enabled():
        try:
            network_provision_result = await provision_team_network(
                team_name=body.name.strip(),
                subnet=assigned_subnet,
                slot=allocated_slot,
            )
            vpn_profile_issued = True
        except NetworkTeamProvisionError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"포털 생성 전에 네트워크 프로비저닝에 실패했습니다. {exc}",
            ) from exc

    # 서브넷 중복 검증 (값이 있을 때만)
    if assigned_subnet:
        subnet_conflict = await db.execute(
            select(Team.id).where(
                Team.competition_id == competition_id,
                Team.subnet == assigned_subnet,
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

    try:
        mutation = await start_team_mutation(
            db,
            resource_key=team_create_resource_key(
                competition_id=competition_id,
                team_name=body.name,
            ),
            operation_type="team.create",
            current_operator=current_operator,
            competition_id=competition_id,
            payload={
                "team_name": body.name,
                "team_code": team_code,
                "auto_allocate_slot": auto_allocate_slot,
                "slot_id": allocated_slot.slot_id if allocated_slot else None,
                "subnet": assigned_subnet,
                "gateway_ip": assigned_gateway_ip,
            },
        )
    except TeamMutationConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    if auto_allocate_slot and slot_pool:
        allocated_slot = await allocate_team_slot(db, slot_pool=slot_pool)
        if allocated_slot is None:
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail="락 획득 후 재검사에서 할당 가능한 팀 슬롯이 사라졌습니다.",
                result={"team_name": body.name},
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="할당 가능한 팀 슬롯이 없습니다. 기존 팀을 삭제하거나 슬롯 풀을 늘려주세요.",
            )
        assigned_subnet = allocated_slot.subnet
        assigned_gateway_ip = allocated_slot.gateway_ip
        assigned_ssh_port = allocated_slot.ssh_port
        assigned_ssh_user = allocated_slot.ssh_user
        assigned_ssh_password = allocated_slot.ssh_password
        vpn_profile_issued = allocated_slot.vpn_profile_issued

    if assigned_subnet:
        subnet_conflict = await db.execute(
            select(Team.id).where(
                Team.competition_id == competition_id,
                Team.subnet == assigned_subnet,
            )
        )
        if subnet_conflict.scalar_one_or_none() is not None:
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail="락 획득 후 재검사에서 VPN 대역 충돌이 확인되었습니다.",
                result={
                    "team_name": body.name,
                    "subnet": assigned_subnet,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="해당 VPN 대역은 이미 다른 팀이 사용 중입니다.",
            )
    team: Team | None = None
    created_discord_role_id: str | None = None
    preflight_network_cleanup_result = None

    try:
        if assigned_subnet and network_team_delete_enabled():
            try:
                preflight_network_cleanup_result = await cleanup_team_network(
                    team_name=body.name,
                    subnet=assigned_subnet,
                    gateway_ip=assigned_gateway_ip,
                    allow_missing=True,
                )
            except NetworkTeamCleanupError as exc:
                await persist_team_mutation_failed(
                    db,
                    mutation_id=mutation.id,
                    error_detail=f"팀 생성 전 stale 네트워크 정리 실패: {exc}",
                    result={
                        "team_name": body.name,
                        "subnet": assigned_subnet,
                        "gateway_ip": assigned_gateway_ip,
                    },
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"팀 생성 전 stale 네트워크 정리에 실패했습니다. {exc}",
                ) from exc

        if assigned_subnet and network_team_provision_enabled():
            try:
                network_provision_result = await provision_team_network(
                    team_name=body.name.strip(),
                    subnet=assigned_subnet,
                    slot=allocated_slot,
                )
                vpn_profile_issued = True
            except NetworkTeamProvisionError as exc:
                detail = f"포털 생성 전에 네트워크 프로비저닝에 실패했습니다. {exc}"
                await persist_team_mutation_failed(
                    db,
                    mutation_id=mutation.id,
                    error_detail=detail,
                    result={
                        "team_name": body.name,
                        "subnet": assigned_subnet,
                        "gateway_ip": assigned_gateway_ip,
                    },
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=detail,
                ) from exc

        team = Team(
            competition_id=competition_id,
            name=body.name,
            team_code=team_code,
            captain_discord_id="UNASSIGNED",
            subnet=assigned_subnet,
            gateway_ip=assigned_gateway_ip,
            vpn_profile_issued=vpn_profile_issued,
            status="pending",
            ssh_port=assigned_ssh_port,
            ssh_user=assigned_ssh_user,
            ssh_password=encrypt_password(assigned_ssh_password) if assigned_ssh_password else None,
        )
        db.add(team)
        await db.flush()
        mutation.team_id = team.id

        await record_audit(
            db, current_operator, "ops.team.create",
            target_type="team", target_id=team.id,
            details={
                "team_name": team.name,
                "team_code": team_code,
                "slot_id": allocated_slot.slot_id if allocated_slot else None,
                "auto_allocated": allocated_slot is not None,
                "subnet": team.subnet,
                "gateway_ip": team.gateway_ip,
                "network_provision_enabled": bool(assigned_subnet and network_team_provision_enabled()),
                "preflight_network_cleanup_alias": (
                    preflight_network_cleanup_result.team_alias
                    if preflight_network_cleanup_result
                    else None
                ),
                "network_provision_alias": (
                    network_provision_result.team_alias if network_provision_result else None
                ),
                "network_provision_net_id": (
                    network_provision_result.net_id if network_provision_result else None
                ),
                "network_provision_usernames": (
                    list(network_provision_result.usernames) if network_provision_result else []
                ),
            },
            ip_address=request.client.host if request.client else None,
        )

        try:
            role_result = await discord_client.create_team_role(team.name)
            created_discord_role_id = role_result.get("role_id")
            team.discord_role_id = created_discord_role_id
            await db.flush()
        except Exception as exc:
            await db.rollback()
            cleanup_warnings: list[str] = []
            if network_provision_result is not None:
                try:
                    await cleanup_team_network(
                        team_name=body.name,
                        subnet=assigned_subnet,
                        gateway_ip=assigned_gateway_ip,
                        allow_missing=True,
                    )
                except NetworkTeamCleanupError as cleanup_exc:
                    cleanup_warnings.append(f"network_rollback_failed={cleanup_exc}")
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail=f"Discord 팀 역할 생성 실패: {exc}",
                result={
                    "team_name": body.name,
                    "subnet": assigned_subnet,
                    "gateway_ip": assigned_gateway_ip,
                    "preflight_network_cleanup_alias": (
                        preflight_network_cleanup_result.team_alias
                        if preflight_network_cleanup_result
                        else None
                    ),
                    "network_provision_alias": (
                        network_provision_result.team_alias if network_provision_result else None
                    ),
                    "warnings": cleanup_warnings,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="포털 생성 전에 Discord 팀 역할 생성에 실패했습니다.",
            ) from exc

        mark_mutation_completed(
            mutation,
            result={
                "team_id": str(team.id),
                "team_name": team.name,
                "team_code": team.team_code,
                "discord_role_id": team.discord_role_id,
                "preflight_network_cleanup_alias": (
                    preflight_network_cleanup_result.team_alias
                    if preflight_network_cleanup_result
                    else None
                ),
                "network_provision_alias": (
                    network_provision_result.team_alias if network_provision_result else None
                ),
            },
        )

        await db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        cleanup_warnings: list[str] = []
        if network_provision_result is not None:
            try:
                await cleanup_team_network(
                    team_name=body.name,
                    subnet=assigned_subnet,
                    gateway_ip=assigned_gateway_ip,
                    allow_missing=True,
                )
            except NetworkTeamCleanupError as cleanup_exc:
                cleanup_warnings.append(f"network_rollback_failed={cleanup_exc}")
        if created_discord_role_id:
            try:
                await discord_client.delete_team_role(created_discord_role_id)
            except Exception as cleanup_exc:
                cleanup_warnings.append(f"discord_role_rollback_failed={cleanup_exc}")

        await persist_team_mutation_failed(
            db,
            mutation_id=mutation.id,
            error_detail=f"팀 생성 저장 실패: {exc}",
            result={
                "team_name": body.name,
                "subnet": assigned_subnet,
                "gateway_ip": assigned_gateway_ip,
                "warnings": cleanup_warnings,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="팀 생성 중 저장에 실패했습니다. 외부 시스템 보상 처리를 시도했습니다.",
        ) from exc

    await publish_event("team:created", {
        "team_id": str(team.id),
        "team_name": team.name,
        "team_code": team.team_code,
        "competition_id": str(competition_id),
        "discord_role_id": team.discord_role_id,
    })

    await db.refresh(team)
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


@router.post("/{team_id}/ssh-password/reveal", response_model=TeamSshPasswordRevealResponse)
async def reveal_team_ssh_password(
    competition_id: UUID,
    team_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamSshPasswordRevealResponse:
    """운영자가 팀 서버 SSH 비밀번호를 일회성으로 조회한다."""
    team = await _get_team_or_404(db, competition_id, team_id)

    if not team.ssh_password:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="저장된 SSH 비밀번호가 없습니다.",
        )

    try:
        plaintext_password = decrypt_password(team.ssh_password)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    revealed_at = datetime.now(timezone.utc)
    await record_audit(
        db, current_operator, "ops.team.ssh_password.reveal",
        target_type="team", target_id=team.id,
        details={"team_name": team.name, "gateway_ip": team.gateway_ip},
        ip_address=request.client.host if request.client else None,
    )

    return TeamSshPasswordRevealResponse(
        team_id=team.id,
        team_name=team.name,
        ssh_user=team.ssh_user,
        ssh_password=plaintext_password,
        revealed_at=revealed_at,
        message="SSH 비밀번호가 일회성으로 조회되었습니다.",
    )


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


@router.get("/{team_id}/mutations")
async def list_team_mutations(
    competition_id: UUID,
    team_id: UUID,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> TeamMutationListResponse:
    """팀 관련 작업 이력을 조회한다."""
    team = await _get_team_or_404(db, competition_id, team_id)
    mutations = (
        await db.execute(
            select(TeamMutation)
            .where(TeamMutation.team_id == team.id)
            .order_by(TeamMutation.started_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    items = [
        TeamMutationItem(
            id=mutation.id,
            operation_type=mutation.operation_type,
            status=mutation.status,
            requested_by_name=mutation.requested_by_name,
            payload=mutation.payload,
            result=mutation.result,
            error_detail=mutation.error_detail,
            started_at=mutation.started_at,
            completed_at=mutation.completed_at,
            retryable=_is_retryable_mutation(mutation),
        )
        for mutation in mutations
    ]

    return TeamMutationListResponse(
        team_id=team.id,
        team_name=team.name,
        items=items,
        total=len(items),
    )


@router.post("/{team_id}/members", status_code=status.HTTP_201_CREATED)
async def add_team_member(
    competition_id: UUID,
    team_id: UUID,
    body: TeamMemberCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamMemberCreateResponse:
    """디스코드 멤버 디렉터리를 기준으로 팀원을 추가/재활성화한다."""
    competition = await _get_competition_or_404(db, competition_id)
    team = await _get_team_or_404(db, competition_id, team_id)

    directory_member = (
        await db.execute(
            select(DiscordGuildMember).where(
                DiscordGuildMember.discord_user_id == body.discord_user_id,
                DiscordGuildMember.is_in_guild.is_(True),
            )
        )
    ).scalar_one_or_none()
    if directory_member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 Discord 사용자를 디렉터리에서 찾을 수 없습니다. 먼저 멤버 동기화를 실행하세요.",
        )
    if directory_member.is_bot:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="봇 계정은 팀원으로 추가할 수 없습니다.",
        )

    other_team_row = (
        await db.execute(
            select(TeamMember, Team)
            .join(Team, Team.id == TeamMember.team_id)
            .where(
                Team.competition_id == competition_id,
                Team.id != team.id,
                TeamMember.discord_user_id == body.discord_user_id,
                TeamMember.status.in_(["pending", "approved"]),
            )
        )
    ).first()
    if other_team_row is not None:
        _, assigned_team = other_team_row
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"해당 Discord 사용자는 이미 '{assigned_team.name}' 팀에 소속되어 있습니다.",
        )

    existing_member = (
        await db.execute(
            select(TeamMember).where(
                TeamMember.team_id == team.id,
                TeamMember.discord_user_id == body.discord_user_id,
            )
        )
    ).scalar_one_or_none()

    active_member_count = (
        await db.execute(
            select(func.count()).select_from(TeamMember).where(
                TeamMember.team_id == team.id,
                TeamMember.status.in_(["pending", "approved"]),
            )
        )
    ).scalar_one()

    if existing_member is None or existing_member.status not in {"pending", "approved"}:
        if active_member_count >= competition.max_members_per_team:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"팀 최대 인원({competition.max_members_per_team}명)을 초과할 수 없습니다.",
            )

    try:
        mutation = await start_team_mutation(
            db,
            resource_key=team_resource_key(team.id),
            operation_type="team.member.add",
            current_operator=current_operator,
            competition_id=competition_id,
            team_id=team.id,
            member_id=existing_member.id if existing_member is not None else None,
            payload={
                "team_name": team.name,
                "discord_user_id": body.discord_user_id,
                "requested_role": body.role,
            },
        )
    except TeamMutationConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    member_name = _preferred_discord_member_name(directory_member)
    now = datetime.now(timezone.utc)

    created_or_reactivated = False
    if existing_member is None:
        member = TeamMember(
            team_id=team.id,
            discord_user_id=body.discord_user_id,
            discord_username=member_name,
            role=body.role,
            status="approved",
            joined_at=now,
        )
        db.add(member)
        message = "팀원이 추가되었습니다."
        created_or_reactivated = True
    else:
        member = existing_member
        previous_status = member.status
        member.discord_username = member_name
        member.role = body.role
        member.status = "approved"
        member.joined_at = now
        message = "팀원 정보가 갱신되었습니다."
        created_or_reactivated = previous_status not in {"pending", "approved"}

    if body.role == "captain":
        prior_captains = (
            await db.execute(
                select(TeamMember).where(
                    TeamMember.team_id == team.id,
                    TeamMember.role == "captain",
                    TeamMember.discord_user_id != body.discord_user_id,
                )
            )
        ).scalars().all()
        for prior in prior_captains:
            prior.role = "member"
        team.captain_discord_id = body.discord_user_id
    elif team.captain_discord_id == body.discord_user_id:
        team.captain_discord_id = "UNASSIGNED"

    team.updated_at = now
    await db.flush()
    member_sequence = await _get_team_member_sequence(
        db,
        team_id=team.id,
        member_id=member.id,
    )

    member_vpn_result = None
    discord_role_granted = False
    if network_team_member_vpn_enabled():
        try:
            member_vpn_result = await provision_team_member_vpn(
                team_name=team.name,
                subnet=team.subnet,
                gateway_ip=team.gateway_ip,
                member_sequence=member_sequence,
                member_display_name=member_name,
                issue_password=created_or_reactivated,
            )
        except NetworkTeamMemberVpnError as exc:
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail=f"팀원 VPN 계정 발급 실패: {exc}",
                result={
                    "team_name": team.name,
                    "discord_user_id": body.discord_user_id,
                    "member_sequence": member_sequence,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"팀원 추가 전에 VPN 계정 발급에 실패했습니다. {exc}",
            ) from exc

    if team.discord_role_id:
        try:
            await discord_client.assign_team_role(body.discord_user_id, team.discord_role_id)
            discord_role_granted = True
        except Exception as exc:
            if member_vpn_result and (member_vpn_result.created or member_vpn_result.reactivated):
                try:
                    await disable_team_member_vpn(
                        team_name=team.name,
                        subnet=team.subnet,
                        gateway_ip=team.gateway_ip,
                        member_sequence=member_sequence,
                    )
                except NetworkTeamMemberVpnError as cleanup_exc:
                    logger.exception(
                        "팀원 추가 Discord 보상 중 VPN 정리에 실패했습니다 "
                        "(team=%s member=%s sequence=%s cleanup=%s)",
                        team.name,
                        body.discord_user_id,
                        member_sequence,
                        cleanup_exc,
                    )
            await db.rollback()
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail=f"Discord 팀 역할 부여 실패: {exc}",
                result={
                    "team_name": team.name,
                    "discord_user_id": body.discord_user_id,
                    "member_sequence": member_sequence,
                    "vpn_username": member_vpn_result.vpn_username if member_vpn_result else None,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="팀원 추가 전에 Discord 역할 부여에 실패했습니다.",
            ) from exc

    if member_vpn_result is not None:
        _store_member_vpn_credentials(
            member,
            vpn_username=member_vpn_result.vpn_username,
            vpn_ip=member_vpn_result.vpn_ip,
            generated_password=member_vpn_result.generated_password,
            updated_at=now,
        )

    await record_audit(
        db,
        current_operator,
        "ops.team.member.add",
        target_type="team",
        target_id=team.id,
        details={
            "team_name": team.name,
            "discord_user_id": body.discord_user_id,
            "discord_username": member_name,
            "role": body.role,
            "message": message,
            "member_sequence": member_sequence,
            "vpn_username": member_vpn_result.vpn_username if member_vpn_result else None,
            "vpn_ip": member_vpn_result.vpn_ip if member_vpn_result else None,
            "vpn_credentials_issued": bool(
                member_vpn_result and member_vpn_result.generated_password
            ),
            "discord_role_granted": discord_role_granted,
        },
        ip_address=request.client.host if request.client else None,
    )

    mark_mutation_completed(
        mutation,
        result={
            "team_name": team.name,
            "discord_user_id": body.discord_user_id,
            "member_id": str(member.id),
            "member_sequence": member_sequence,
            "vpn_username": member_vpn_result.vpn_username if member_vpn_result else None,
            "vpn_ip": member_vpn_result.vpn_ip if member_vpn_result else None,
            "discord_role_granted": discord_role_granted,
        },
    )

    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        if member_vpn_result and (member_vpn_result.created or member_vpn_result.reactivated):
            try:
                await disable_team_member_vpn(
                    team_name=team.name,
                    subnet=team.subnet,
                    gateway_ip=team.gateway_ip,
                    member_sequence=member_sequence,
                )
            except NetworkTeamMemberVpnError:
                logger.exception(
                    "팀원 DB 롤백 후 VPN 계정 보상 정리에 실패했습니다 "
                    "(team=%s member=%s sequence=%s)",
                    team.name,
                    body.discord_user_id,
                    member_sequence,
                )
        if discord_role_granted and team.discord_role_id:
            try:
                await discord_client.revoke_team_role(body.discord_user_id, team.discord_role_id)
            except Exception:
                logger.exception(
                    "팀원 추가 DB 롤백 후 Discord 역할 원복에 실패했습니다 "
                    "(team=%s member=%s role_id=%s)",
                    team.name,
                    body.discord_user_id,
                    team.discord_role_id,
                )
        await persist_team_mutation_failed(
            db,
            mutation_id=mutation.id,
            error_detail=f"팀원 저장 중 오류가 발생했습니다. {exc}",
            result={
                "team_name": team.name,
                "discord_user_id": body.discord_user_id,
                "member_sequence": member_sequence,
                "vpn_username": member_vpn_result.vpn_username if member_vpn_result else None,
                "discord_role_granted": discord_role_granted,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"팀원 저장 중 오류가 발생했습니다. {exc}",
        ) from exc

    return TeamMemberCreateResponse(
        id=member.id,
        discord_user_id=member.discord_user_id,
        discord_username=member.discord_username,
        role=member.role,
        status=member.status,
        joined_at=member.joined_at,
        team_id=team.id,
        team_name=team.name,
        message=message,
        vpn_username=member_vpn_result.vpn_username if member_vpn_result else None,
        vpn_ip=member_vpn_result.vpn_ip if member_vpn_result else None,
        generated_vpn_password=member_vpn_result.generated_password if member_vpn_result else None,
        vpn_credentials_issued=bool(member_vpn_result and member_vpn_result.generated_password),
    )


@router.delete("/{team_id}/members/{member_id}")
async def remove_team_member(
    competition_id: UUID,
    team_id: UUID,
    member_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamMemberRemoveResponse:
    """개별 팀원을 퇴장 처리하고 Discord 역할/VPN 계정을 함께 정리한다."""
    team = await _get_team_or_404(db, competition_id, team_id)
    member = await _get_team_member_or_404(
        db,
        team_id=team.id,
        member_id=member_id,
    )

    if member.status not in {"pending", "approved"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 비활성화된 팀원입니다.",
        )

    now = datetime.now(timezone.utc)
    member_sequence = await _get_team_member_sequence(
        db,
        team_id=team.id,
        member_id=member.id,
    )
    previous_role = member.role
    previous_status = member.status
    member_name = member.discord_username or member.discord_user_id
    vpn_username = None
    vpn_disable_result = None
    discord_role_revoked = False

    try:
        mutation = await start_team_mutation(
            db,
            resource_key=team_resource_key(team.id),
            operation_type="team.member.remove",
            current_operator=current_operator,
            competition_id=competition_id,
            team_id=team.id,
            member_id=member.id,
            payload={
                "team_name": team.name,
                "discord_user_id": member.discord_user_id,
                "member_id": str(member.id),
            },
        )
    except TeamMutationConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    if network_team_member_vpn_enabled():
        try:
            vpn_disable_result = await disable_team_member_vpn(
                team_name=team.name,
                subnet=team.subnet,
                gateway_ip=team.gateway_ip,
                member_sequence=member_sequence,
            )
            if vpn_disable_result is not None:
                vpn_username = vpn_disable_result.vpn_username
        except NetworkTeamMemberVpnError as exc:
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail=f"팀원 VPN 계정 비활성화 실패: {exc}",
                result={
                    "team_name": team.name,
                    "discord_user_id": member.discord_user_id,
                    "member_sequence": member_sequence,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"팀원 퇴장 전에 VPN 계정 비활성화에 실패했습니다. {exc}",
            ) from exc

    if team.discord_role_id:
        try:
            await discord_client.revoke_team_role(member.discord_user_id, team.discord_role_id)
            discord_role_revoked = True
        except Exception as exc:
            if vpn_disable_result and vpn_disable_result.disabled:
                try:
                    await provision_team_member_vpn(
                        team_name=team.name,
                        subnet=team.subnet,
                        gateway_ip=team.gateway_ip,
                        member_sequence=member_sequence,
                        member_display_name=member_name,
                        issue_password=False,
                    )
                except NetworkTeamMemberVpnError as cleanup_exc:
                    logger.exception(
                        "팀원 퇴장 Discord 보상 중 VPN 원복에 실패했습니다 "
                        "(team=%s member=%s sequence=%s cleanup=%s)",
                        team.name,
                        member.discord_user_id,
                        member_sequence,
                        cleanup_exc,
                    )
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail=f"Discord 팀 역할 회수 실패: {exc}",
                result={
                    "team_name": team.name,
                    "discord_user_id": member.discord_user_id,
                    "member_sequence": member_sequence,
                    "vpn_username": vpn_username,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="팀원 퇴장 전에 Discord 역할 회수에 실패했습니다.",
            ) from exc

    member.status = "kicked"
    if vpn_username:
        member.vpn_username = vpn_username
    _clear_member_vpn_secret(member, updated_at=now)
    team.updated_at = now
    if team.captain_discord_id == member.discord_user_id:
        team.captain_discord_id = "UNASSIGNED"

    await record_audit(
        db,
        current_operator,
        "ops.team.member.remove",
        target_type="team",
        target_id=team.id,
        details={
            "team_name": team.name,
            "discord_user_id": member.discord_user_id,
            "discord_username": member_name,
            "previous_role": previous_role,
            "previous_status": previous_status,
            "new_status": member.status,
            "member_sequence": member_sequence,
            "vpn_username": vpn_username,
            "vpn_disabled": bool(vpn_disable_result and vpn_disable_result.disabled),
            "discord_role_revoked": discord_role_revoked,
        },
        ip_address=request.client.host if request.client else None,
    )

    mark_mutation_completed(
        mutation,
        result={
            "team_name": team.name,
            "discord_user_id": member.discord_user_id,
            "member_id": str(member.id),
            "member_sequence": member_sequence,
            "vpn_username": vpn_username,
            "vpn_disabled": bool(vpn_disable_result and vpn_disable_result.disabled),
            "discord_role_revoked": discord_role_revoked,
        },
    )

    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        if vpn_disable_result and vpn_disable_result.disabled:
            try:
                await provision_team_member_vpn(
                    team_name=team.name,
                    subnet=team.subnet,
                    gateway_ip=team.gateway_ip,
                    member_sequence=member_sequence,
                    member_display_name=member_name,
                    issue_password=False,
                )
            except NetworkTeamMemberVpnError:
                logger.exception(
                    "팀원 퇴장 DB 롤백 후 VPN 계정 원복에 실패했습니다 "
                    "(team=%s member=%s sequence=%s)",
                    team.name,
                    member.discord_user_id,
                    member_sequence,
                )
        if discord_role_revoked and team.discord_role_id:
            try:
                await discord_client.assign_team_role(member.discord_user_id, team.discord_role_id)
            except Exception:
                logger.exception(
                    "팀원 퇴장 DB 롤백 후 Discord 역할 원복에 실패했습니다 "
                    "(team=%s member=%s role_id=%s)",
                    team.name,
                    member.discord_user_id,
                    team.discord_role_id,
                )
        await persist_team_mutation_failed(
            db,
            mutation_id=mutation.id,
            error_detail=f"팀원 퇴장 저장 중 오류가 발생했습니다. {exc}",
            result={
                "team_name": team.name,
                "discord_user_id": member.discord_user_id,
                "member_sequence": member_sequence,
                "vpn_username": vpn_username,
                "vpn_disabled": bool(vpn_disable_result and vpn_disable_result.disabled),
                "discord_role_revoked": discord_role_revoked,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"팀원 퇴장 저장 중 오류가 발생했습니다. {exc}",
        ) from exc

    return TeamMemberRemoveResponse(
        id=member.id,
        discord_user_id=member.discord_user_id,
        discord_username=member.discord_username,
        role=member.role,
        status=member.status,
        joined_at=member.joined_at,
        team_id=team.id,
        team_name=team.name,
        message="팀원이 퇴장 처리되었습니다.",
        vpn_username=vpn_username,
        vpn_disabled=bool(vpn_disable_result and vpn_disable_result.disabled),
    )


@router.post("/{team_id}/members/vpn-txt")
async def download_team_members_vpn_txt(
    competition_id: UUID,
    team_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> Response:
    """활성 팀원 전체의 VPN 접속 정보를 TXT로 내려받는다."""
    team = await _get_team_or_404(db, competition_id, team_id)

    active_members = (
        await db.execute(
            select(TeamMember)
            .where(
                TeamMember.team_id == team.id,
                TeamMember.status.in_(("pending", "approved")),
            )
            .order_by(TeamMember.created_at.asc(), TeamMember.id.asc())
        )
    ).scalars().all()

    if not active_members:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="VPN 정보를 발급할 활성 팀원이 없습니다.",
        )

    try:
        mutation = await start_team_mutation(
            db,
            resource_key=team_resource_key(team.id),
            operation_type="team.vpn.bundle.issue",
            current_operator=current_operator,
            competition_id=competition_id,
            team_id=team.id,
            payload={
                "team_name": team.name,
                "member_count": len(active_members),
            },
        )
    except TeamMutationConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    issued_at = datetime.now(timezone.utc)
    reissued_count = 0
    exported_members: list[dict[str, str]] = []
    warnings: list[str] = []

    try:
        for member in active_members:
            stored_password: str | None = None
            if member.vpn_password:
                try:
                    stored_password = decrypt_password(member.vpn_password)
                except ValueError:
                    warnings.append(
                        f"{member.discord_username or member.discord_user_id} 팀원의 저장된 VPN 비밀번호를 복호화하지 못해 재발급합니다."
                    )

            if member.vpn_username and member.vpn_ip and stored_password:
                exported_members.append(
                    {
                        "discord_username": member.discord_username or member.discord_user_id,
                        "discord_user_id": member.discord_user_id,
                        "role": member.role,
                        "status": member.status,
                        "vpn_username": member.vpn_username,
                        "vpn_password": stored_password,
                        "vpn_ip": member.vpn_ip,
                    }
                )
                continue

            if not network_team_member_vpn_enabled():
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=(
                        "저장된 VPN 비밀번호가 없는 팀원이 있지만 라우터 VPN 자동화가 비활성화되어 "
                        "TXT를 발급할 수 없습니다."
                    ),
                )

            member_sequence = await _get_team_member_sequence(
                db,
                team_id=team.id,
                member_id=member.id,
            )
            member_display_name = member.discord_username or member.discord_user_id
            provision_result = await provision_team_member_vpn(
                team_name=team.name,
                subnet=team.subnet,
                gateway_ip=team.gateway_ip,
                member_sequence=member_sequence,
                member_display_name=member_display_name,
                issue_password=True,
            )
            if not provision_result.generated_password:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"{member_display_name} 팀원의 VPN 비밀번호 재발급 결과를 확인하지 못했습니다.",
                )

            _store_member_vpn_credentials(
                member,
                vpn_username=provision_result.vpn_username,
                vpn_ip=provision_result.vpn_ip,
                generated_password=provision_result.generated_password,
                updated_at=issued_at,
            )
            await db.commit()
            reissued_count += 1

            exported_members.append(
                {
                    "discord_username": member_display_name,
                    "discord_user_id": member.discord_user_id,
                    "role": member.role,
                    "status": member.status,
                    "vpn_username": provision_result.vpn_username,
                    "vpn_password": provision_result.generated_password,
                    "vpn_ip": provision_result.vpn_ip,
                }
            )

        audit_details = {
            "team_name": team.name,
            "team_code": team.team_code,
            "member_count": len(exported_members),
            "reissued_password_count": reissued_count,
        }
        if warnings:
            audit_details["warnings"] = warnings

        await record_audit(
            db,
            current_operator,
            "ops.team.member.vpn_txt.download",
            target_type="team",
            target_id=team.id,
            details=audit_details,
            ip_address=request.client.host if request.client else None,
        )

        result_payload = {
            "team_name": team.name,
            "member_count": len(exported_members),
            "reissued_password_count": reissued_count,
        }
        if warnings:
            result_payload["warnings"] = warnings
        mark_mutation_completed(
            mutation,
            result=result_payload,
        )
        await db.commit()
    except HTTPException as exc:
        await db.rollback()
        await persist_team_mutation_failed(
            db,
            mutation_id=mutation.id,
            error_detail=str(exc.detail),
            result={
                "team_name": team.name,
                "member_count": len(exported_members),
                "reissued_password_count": reissued_count,
            },
        )
        raise
    except Exception as exc:
        await db.rollback()
        await persist_team_mutation_failed(
            db,
            mutation_id=mutation.id,
            error_detail=f"팀 VPN TXT 발급 중 오류가 발생했습니다. {exc}",
            result={
                "team_name": team.name,
                "member_count": len(exported_members),
                "reissued_password_count": reissued_count,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"팀 VPN TXT 발급 중 오류가 발생했습니다. {exc}",
        ) from exc

    txt_payload = _build_team_members_vpn_bundle_text(
        team=team,
        generated_at=issued_at,
        members=exported_members,
        reissued_count=reissued_count,
    )
    ascii_filename = _sanitize_download_filename_fragment(f"{team.name}-vpn-access")
    utf8_filename = quote(f"{team.name}-vpn-access.txt")
    return Response(
        content=txt_payload,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{ascii_filename}.txt\"; "
                f"filename*=UTF-8''{utf8_filename}"
            )
        },
    )


@router.post("/{team_id}/mutations/{mutation_id}/retry")
async def retry_team_mutation(
    competition_id: UUID,
    team_id: UUID,
    mutation_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamMutationRetryResponse:
    """실패한 팀 작업을 같은 payload로 다시 실행한다."""
    team = await _get_team_or_404(db, competition_id, team_id)
    mutation = await _get_team_mutation_or_404(
        db,
        team_id=team.id,
        mutation_id=mutation_id,
    )
    if not _is_retryable_mutation(mutation):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="재시도할 수 없는 작업입니다.",
        )

    payload = mutation.payload or {}

    if mutation.operation_type == "team.member.add":
        discord_user_id = str(payload.get("discord_user_id") or "").strip()
        requested_role = str(payload.get("requested_role") or "member").strip() or "member"
        if not discord_user_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="재시도에 필요한 Discord 사용자 정보가 없습니다.",
            )
        if requested_role not in {"captain", "member"}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="재시도에 필요한 팀 역할 정보가 올바르지 않습니다.",
            )
        await add_team_member(
            competition_id=competition_id,
            team_id=team.id,
            body=TeamMemberCreateRequest(
                discord_user_id=discord_user_id,
                role=requested_role,
            ),
            request=request,
            db=db,
            current_operator=current_operator,
        )
        return TeamMutationRetryResponse(
            mutation_id=mutation.id,
            operation_type=mutation.operation_type,
            message="팀원 추가 작업을 다시 실행했습니다.",
        )

    if mutation.operation_type == "team.member.remove":
        member_id_raw = mutation.member_id or payload.get("member_id")
        if not member_id_raw:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="재시도에 필요한 팀원 정보가 없습니다.",
            )
        member_uuid = member_id_raw if isinstance(member_id_raw, UUID) else UUID(str(member_id_raw))
        await remove_team_member(
            competition_id=competition_id,
            team_id=team.id,
            member_id=member_uuid,
            request=request,
            db=db,
            current_operator=current_operator,
        )
        return TeamMutationRetryResponse(
            mutation_id=mutation.id,
            operation_type=mutation.operation_type,
            message="팀원 퇴장 작업을 다시 실행했습니다.",
        )

    if mutation.operation_type == "team.delete":
        await delete_team(
            competition_id=competition_id,
            team_id=team.id,
            request=request,
            db=db,
            current_operator=current_operator,
        )
        return TeamMutationRetryResponse(
            mutation_id=mutation.id,
            operation_type=mutation.operation_type,
            message="팀 삭제 작업을 다시 실행했습니다.",
            team_deleted=True,
        )

    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail="지원하지 않는 작업 타입입니다.",
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

    # TeamService + VulnService JOIN으로 서비스 정의와 헬스체크 설정을 함께 가져온다.
    result = await db.execute(
        select(TeamService, VulnService)
        .join(VulnService, TeamService.service_id == VulnService.id)
        .where(TeamService.team_id == team_id)
        .order_by(TeamService.created_at.asc())
    )
    rows = result.all()

    items: list[TeamServiceItem] = []
    for ts, service in rows:
        latest_sla_result = await db.execute(
            select(SlaCheck)
            .where(
                SlaCheck.team_id == team_id,
                SlaCheck.service_id == ts.service_id,
            )
            .order_by(SlaCheck.checked_at.desc())
            .limit(1)
        )
        latest_sla = latest_sla_result.scalar_one_or_none()

        item = TeamServiceItem(
            id=ts.id,
            service_id=ts.service_id,
            service_name=service.name,
            host_ip=ts.host_ip,
            port=ts.port,
            container_id=ts.container_id,
            status=ts.status,
            last_health_check_at=ts.last_health_check_at or (latest_sla.checked_at if latest_sla else None),
            last_health_check_result=(
                ts.last_health_check_result
                if ts.last_health_check_result is not None
                else (latest_sla.is_up if latest_sla else None)
            ),
            health_check_endpoint=service.health_check_endpoint,
            healthcheck_scenarios=service.healthcheck_scenarios,
            last_health_check_type=latest_sla.check_type if latest_sla else None,
            last_health_check_error=latest_sla.error_message if latest_sla else None,
            last_health_check_response_time_ms=latest_sla.response_time_ms if latest_sla else None,
        )
        items.append(item)

    return TeamServiceListResponse(
        team_id=team.id,
        team_name=team.name,
        items=items,
        total=len(items),
    )


@router.get("/{team_id}/services/{team_service_id}/healthcheck")
async def run_team_service_healthcheck(
    competition_id: UUID,
    team_id: UUID,
    team_service_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> TeamServiceHealthcheckLiveResponse:
    """팀 서비스에 대한 실시간 헬스체크를 수행하고 step별 결과를 반환한다."""
    team = await _get_team_or_404(db, competition_id, team_id)

    result = await db.execute(
        select(TeamService, VulnService)
        .join(VulnService, TeamService.service_id == VulnService.id)
        .where(
            TeamService.id == team_service_id,
            TeamService.team_id == team_id,
        )
    )
    row = result.first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="팀 서비스를 찾을 수 없습니다.",
        )

    team_service, service = row
    base_url = f"http://{team_service.host_ip}:{team_service.port}"
    health_endpoint = service.health_check_endpoint or "/healthz"
    healthcheck_scenarios = service.healthcheck_scenarios

    try:
        if (
            isinstance(healthcheck_scenarios, dict)
            and (healthcheck_scenarios.get("steps") or [])
        ):
            run_result = await run_scenario_healthcheck(base_url, healthcheck_scenarios)
        elif health_endpoint:
            run_result = await run_basic_http_healthcheck(
                team_service.host_ip,
                team_service.port,
                health_endpoint,
            )
        else:
            run_result = await run_basic_tcp_healthcheck(
                team_service.host_ip,
                team_service.port,
            )
    except Exception as exc:
        logger.exception(
            "팀 서비스 실시간 헬스체크 실패 (team_id=%s, team_service_id=%s)",
            team_id,
            team_service_id,
        )
        run_result = {
            "check_type": "custom_script" if healthcheck_scenarios else "http_get" if health_endpoint else "tcp_connect",
            "is_up": False,
            "response_time_ms": None,
            "error_message": f"헬스체크 실행 실패: {exc}",
            "checked_at": datetime.now(timezone.utc),
            "steps": [],
        }

    return TeamServiceHealthcheckLiveResponse(
        team_id=team.id,
        team_service_id=team_service.id,
        service_id=service.id,
        service_name=service.name,
        check_type=str(run_result.get("check_type") or "custom_script"),
        is_up=bool(run_result.get("is_up")),
        response_time_ms=run_result.get("response_time_ms"),
        error_message=run_result.get("error_message"),
        checked_at=run_result.get("checked_at") or datetime.now(timezone.utc),
        steps=run_result.get("steps") or [],
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

    삭제 시 가능한 경우 팀 서버의 런타임 컨테이너와 라우터 네트워크 설정도
    함께 정리한다. 어느 한 단계라도 실패하면 포털 DB 삭제를 중단한다.
    """
    team = await _get_team_or_404(db, competition_id, team_id)

    member_count = (await db.execute(
        select(func.count()).select_from(TeamMember).where(TeamMember.team_id == team_id)
    )).scalar_one()
    service_count = (await db.execute(
        select(func.count()).select_from(TeamService).where(TeamService.team_id == team_id)
    )).scalar_one()

    try:
        mutation = await start_team_mutation(
            db,
            resource_key=team_resource_key(team.id),
            operation_type="team.delete",
            current_operator=current_operator,
            competition_id=competition_id,
            team_id=team.id,
            payload={
                "team_name": team.name,
                "team_code": team.team_code,
                "subnet": team.subnet,
                "gateway_ip": team.gateway_ip,
                "member_count": member_count,
                "service_count": service_count,
            },
        )
    except TeamMutationConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    runtime_cleanup_result = None
    runtime_cleanup_is_enabled = runtime_team_cleanup_enabled(
        gateway_ip=team.gateway_ip,
        ssh_user=team.ssh_user,
        ssh_password=team.ssh_password,
        team_code=team.team_code,
    )
    if runtime_cleanup_is_enabled:
        try:
            runtime_cleanup_result = await cleanup_team_runtime(
                gateway_ip=team.gateway_ip or "",
                ssh_port=team.ssh_port or 22,
                ssh_user=team.ssh_user or "",
                ssh_password=decrypt_password(team.ssh_password or ""),
                team_code=team.team_code,
            )
        except (RuntimeTeamCleanupError, ValueError) as exc:
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail=f"팀 서버 런타임 정리 실패: {exc}",
                result={
                    "team_name": team.name,
                    "team_code": team.team_code,
                    "gateway_ip": team.gateway_ip,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"포털 삭제 전에 팀 서버 런타임 정리에 실패했습니다. {exc}",
            ) from exc
    elif service_count > 0:
        await persist_team_mutation_failed(
            db,
            mutation_id=mutation.id,
            error_detail="팀 서비스가 남아 있지만 런타임 정리용 SSH 정보가 없습니다.",
            result={
                "team_name": team.name,
                "team_code": team.team_code,
                "service_count": service_count,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "팀 서비스가 남아 있지만 팀 서버 SSH 정보가 없어 자동 런타임 정리를 진행할 수 없습니다. "
                "SSH 설정을 확인한 뒤 다시 시도하세요."
            ),
        )

    network_cleanup_result = None
    if network_team_delete_enabled():
        try:
            network_cleanup_result = await cleanup_team_network(
                team_name=team.name,
                subnet=team.subnet,
                gateway_ip=team.gateway_ip,
                allow_missing=True,
            )
        except NetworkTeamCleanupError as exc:
            await persist_team_mutation_failed(
                db,
                mutation_id=mutation.id,
                error_detail=f"네트워크 정리 실패: {exc}",
                result={
                    "team_name": team.name,
                    "team_code": team.team_code,
                    "subnet": team.subnet,
                    "gateway_ip": team.gateway_ip,
                    "runtime_cleanup_removed_names": (
                        list(runtime_cleanup_result.removed_names) if runtime_cleanup_result else []
                    ),
                },
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"포털 삭제 전에 네트워크 정리에 실패했습니다. {exc}",
            ) from exc

    await record_audit(
        db, current_operator, "ops.team.delete",
        target_type="team", target_id=team.id,
        details={
            "team_name": team.name,
            "team_code": team.team_code,
            "status_at_delete": team.status,
            "member_count": member_count,
            "service_count": service_count,
            "runtime_cleanup_enabled": runtime_cleanup_is_enabled,
            "runtime_cleanup_host": (
                runtime_cleanup_result.host if runtime_cleanup_result else team.gateway_ip
            ),
            "runtime_cleanup_removed_count": (
                runtime_cleanup_result.removed_count if runtime_cleanup_result else 0
            ),
            "runtime_cleanup_removed_names": (
                list(runtime_cleanup_result.removed_names) if runtime_cleanup_result else []
            ),
            "runtime_cleanup_network_removed": (
                runtime_cleanup_result.network_removed if runtime_cleanup_result else False
            ),
            "network_cleanup_enabled": network_team_delete_enabled(),
            "network_cleanup_alias": (
                network_cleanup_result.team_alias if network_cleanup_result else None
            ),
        },
        ip_address=request.client.host if request.client else None,
    )
    mark_mutation_completed(
        mutation,
        result={
            "team_name": team.name,
            "team_code": team.team_code,
            "member_count": member_count,
            "service_count": service_count,
            "runtime_cleanup_removed_count": (
                runtime_cleanup_result.removed_count if runtime_cleanup_result else 0
            ),
            "runtime_cleanup_removed_names": (
                list(runtime_cleanup_result.removed_names) if runtime_cleanup_result else []
            ),
            "network_cleanup_alias": (
                network_cleanup_result.team_alias if network_cleanup_result else None
            ),
        },
    )

    discord_role_id = team.discord_role_id

    try:
        await db.delete(team)
        await db.commit()
    except Exception as exc:
        await db.rollback()
        await persist_team_mutation_failed(
            db,
            mutation_id=mutation.id,
            error_detail=f"포털 DB 삭제 최종 반영 실패: {exc}",
            result={
                "team_name": team.name,
                "team_code": team.team_code,
                "runtime_cleanup_removed_count": (
                    runtime_cleanup_result.removed_count if runtime_cleanup_result else 0
                ),
                "runtime_cleanup_removed_names": (
                    list(runtime_cleanup_result.removed_names) if runtime_cleanup_result else []
                ),
                "network_cleanup_alias": (
                    network_cleanup_result.team_alias if network_cleanup_result else None
                ),
                "external_cleanup_completed": True,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="팀 외부 정리는 완료됐지만 포털 DB 삭제 마무리에 실패했습니다. 재시도하면 안전하게 다시 정리됩니다.",
        ) from exc

    if discord_role_id:
        try:
            await discord_client.delete_team_role(discord_role_id)
        except Exception as exc:
            logger.warning(
                "Discord 팀 역할 삭제 실패 (team_name=%s, role_id=%s): %s. "
                "관리자가 Discord에서 수동으로 역할 정리 필요.",
                team.name, discord_role_id, exc,
            )
            await append_team_mutation_warning(
                db,
                mutation_id=mutation.id,
                warning=f"discord_role_delete_failed={exc}",
            )
