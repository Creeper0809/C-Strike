"""네트워크 관제 API 라우터 — 팀별 네트워크 상태 모니터링 및 격리/복구."""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import require_role
from app.models.competition import Competition
from app.models.operator import Operator
from app.models.team import Team
from app.models.team_service import TeamService
from app.models.vuln_service import VulnService
from app.schemas.network import (
    BulkIsolateResponse,
    BulkRestoreResponse,
    DeployStatusResponse,
    NetworkIsolateRequest,
    NetworkRestoreRequest,
    NetworkStatusResponse,
    SubnetAssignRequest,
    SubnetAssignResponse,
    SubnetAutoAssignRequest,
    SubnetAutoAssignResponse,
    SubnetBulkAssignRequest,
    SubnetListResponse,
    TeamDeployStatus,
    TeamIsolateResponse,
    TeamNetworkDetail,
    TeamNetworkSummary,
    TeamRestoreResponse,
    TeamServiceNetworkInfo,
    TeamSubnetInfo,
)
from app.utils.audit import record_audit
from app.utils.network_isolation import (
    clear_team_isolated,
    get_isolated_team_ids,
    get_isolation_info,
    is_team_isolated,
    isolate_all_teams,
    restore_all_teams,
    set_team_isolated,
)

router = APIRouter(tags=["네트워크 관제"])


# ── 헬퍼 함수 ──────────────────────────────────────────────

async def _get_competition_or_404(db: AsyncSession, competition_id: UUID) -> Competition:
    """대회를 조회하고, 없으면 404를 반환한다."""
    result = await db.execute(
        select(Competition).where(Competition.id == competition_id)
    )
    comp = result.scalar_one_or_none()
    if comp is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="대회를 찾을 수 없습니다.",
        )
    return comp


async def _get_team_or_404(db: AsyncSession, competition_id: UUID, team_id: UUID) -> Team:
    """대회 소속 팀을 조회하고, 없으면 404를 반환한다."""
    result = await db.execute(
        select(Team).where(Team.id == team_id, Team.competition_id == competition_id)
    )
    team = result.scalar_one_or_none()
    if team is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 대회에서 팀을 찾을 수 없습니다.",
        )
    return team


async def _get_approved_teams(db: AsyncSession, competition_id: UUID) -> list[Team]:
    """대회에 승인된 팀 목록을 조회한다."""
    result = await db.execute(
        select(Team)
        .where(Team.competition_id == competition_id, Team.status.in_(["approved", "active"]))
        .order_by(Team.name)
    )
    return list(result.scalars().all())


def _infer_network_status(
    team: Team,
    running_services: int,
    total_services: int,
    is_isolated_explicit: bool = False,
) -> str:
    """팀의 네트워크 상태를 결정한다.

    우선순위:
    1. Redis에 명시적으로 격리 표시된 팀 (운영자 격리 액션 결과) → isolated
    2. disqualified 상태인 팀 → isolated
    3. 모든 서비스가 정지된 팀 (서비스가 1개 이상이면서 running=0) → isolated
    4. 그 외 → connected
    """
    if is_isolated_explicit:
        return "isolated"
    if team.status == "disqualified":
        return "isolated"
    if total_services > 0 and running_services == 0:
        return "isolated"
    return "connected"


async def _get_team_services_with_names(
    db: AsyncSession, team_id: UUID
) -> list[tuple[TeamService, str]]:
    """팀의 서비스 인스턴스와 서비스 이름을 함께 조회한다."""
    result = await db.execute(
        select(TeamService, VulnService.name)
        .join(VulnService, TeamService.service_id == VulnService.id)
        .where(TeamService.team_id == team_id)
    )
    return list(result.all())


async def _build_team_summary(
    db: AsyncSession,
    team: Team,
    is_isolated_explicit: bool = False,
    isolation_info: dict | None = None,
) -> TeamNetworkSummary:
    """팀의 네트워크 요약 정보를 구성한다."""
    services_data = await _get_team_services_with_names(db, team.id)
    total = len(services_data)
    running = sum(1 for ts, _ in services_data if ts.status == "running")
    net_status = _infer_network_status(team, running, total, is_isolated_explicit)

    # 마지막 헬스 체크 시각을 서비스 인스턴스 중 최신값으로 결정
    last_checked = None
    for ts, _ in services_data:
        if ts.last_health_check_at is not None:
            if last_checked is None or ts.last_health_check_at > last_checked:
                last_checked = ts.last_health_check_at

    isolated_at_dt = None
    isolation_reason = None
    if isolation_info:
        raw_isolated_at = isolation_info.get("isolated_at")
        if raw_isolated_at:
            try:
                isolated_at_dt = datetime.fromisoformat(raw_isolated_at)
            except ValueError:
                isolated_at_dt = None
        isolation_reason = isolation_info.get("reason")

    return TeamNetworkSummary(
        team_id=team.id,
        team_name=team.name,
        subnet=team.subnet,
        gateway_ip=team.gateway_ip,
        status=net_status,
        ping_ms=None,  # TODO: 실제 ping 측정 연동 시 구현
        last_checked_at=last_checked,
        isolated_at=isolated_at_dt,
        isolation_reason=isolation_reason,
    )


# ── 엔드포인트 ──────────────────────────────────────────────

@router.get("/status")
async def get_network_status(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin", "operator")),
) -> NetworkStatusResponse:
    """전체 네트워크 상태를 조회한다."""
    comp = await _get_competition_or_404(db, competition_id)
    teams = await _get_approved_teams(db, competition_id)

    isolated_ids = await get_isolated_team_ids(competition_id)

    team_summaries: list[TeamNetworkSummary] = []
    for team in teams:
        is_isolated_explicit = str(team.id) in isolated_ids
        isolation_info = await get_isolation_info(team.id) if is_isolated_explicit else None
        summary = await _build_team_summary(
            db, team, is_isolated_explicit=is_isolated_explicit, isolation_info=isolation_info
        )
        team_summaries.append(summary)

    teams_isolated = sum(1 for t in team_summaries if t.status == "isolated")
    teams_online = len(team_summaries) - teams_isolated

    return NetworkStatusResponse(
        competition_id=comp.id,
        participant_subnet=comp.network_participant_subnet,
        ops_subnet=comp.network_ops_subnet,
        total_teams=len(team_summaries),
        teams_online=teams_online,
        teams_isolated=teams_isolated,
        is_all_isolated=(len(team_summaries) > 0 and teams_isolated == len(team_summaries)),
        teams=team_summaries,
    )


@router.get("/teams/{team_id}")
async def get_team_network_detail(
    competition_id: UUID,
    team_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin", "operator")),
) -> TeamNetworkDetail:
    """특정 팀의 네트워크 상세 상태를 조회한다."""
    await _get_competition_or_404(db, competition_id)
    team = await _get_team_or_404(db, competition_id, team_id)

    services_data = await _get_team_services_with_names(db, team.id)
    total = len(services_data)
    running = sum(1 for ts, _ in services_data if ts.status == "running")
    is_isolated_explicit = await is_team_isolated(team.id)
    net_status = _infer_network_status(team, running, total, is_isolated_explicit)

    service_infos: list[TeamServiceNetworkInfo] = []
    last_checked = None
    for ts, svc_name in services_data:
        reachable = ts.status == "running" and ts.last_health_check_result is True
        service_infos.append(TeamServiceNetworkInfo(
            service_name=svc_name,
            host_ip=ts.host_ip,
            port=ts.port,
            reachable=reachable,
            response_time_ms=None,  # TODO: 실제 응답 시간 측정 연동
        ))
        if ts.last_health_check_at is not None:
            if last_checked is None or ts.last_health_check_at > last_checked:
                last_checked = ts.last_health_check_at

    return TeamNetworkDetail(
        team_id=team.id,
        team_name=team.name,
        subnet=team.subnet,
        gateway_ip=team.gateway_ip,
        status=net_status,
        ping_ms=None,  # TODO: 실제 ping 측정 연동 시 구현
        vpn_profile_issued=team.vpn_profile_issued,
        active_connections=running,
        services=service_infos,
        last_checked_at=last_checked,
    )


@router.post("/teams/{team_id}/isolate")
async def isolate_team_network(
    competition_id: UUID,
    team_id: UUID,
    body: NetworkIsolateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamIsolateResponse:
    """특정 팀의 네트워크를 격리한다.

    Redis에 격리 상태를 명시적으로 기록하여 운영 포털 화면 및 다른 서비스에서
    정확히 추적 가능하다. 실제 iptables 차단은 인프라 담당자(라우터/방화벽) 영역.
    """
    await _get_competition_or_404(db, competition_id)
    team = await _get_team_or_404(db, competition_id, team_id)

    # 명시적 격리 상태 우선 확인
    if await is_team_isolated(team.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 격리된 상태입니다.",
        )

    isolated_at = await set_team_isolated(
        team_id=team.id,
        competition_id=competition_id,
        reason=body.reason,
        operator_id=current_operator.id,
    )

    await record_audit(
        db, current_operator, "ops.network.isolate",
        target_type="team", target_id=team.id,
        details={"reason": body.reason, "subnet": team.subnet},
        ip_address=request.client.host if request.client else None,
    )

    return TeamIsolateResponse(
        team_id=team.id,
        team_name=team.name,
        subnet=team.subnet,
        status="isolated",
        message="팀 네트워크가 격리되었습니다.",
        reason=body.reason,
        isolated_at=isolated_at,
    )


@router.post("/teams/{team_id}/restore")
async def restore_team_network(
    competition_id: UUID,
    team_id: UUID,
    body: NetworkRestoreRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> TeamRestoreResponse:
    """격리된 팀의 네트워크를 복구한다.

    Redis 격리 플래그를 해제한다. 실제 iptables 복구는 인프라 담당자 영역.
    """
    await _get_competition_or_404(db, competition_id)
    team = await _get_team_or_404(db, competition_id, team_id)

    # 명시적 격리 상태인지 확인
    if not await is_team_isolated(team.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="격리 상태가 아닙니다.",
        )

    await clear_team_isolated(team.id, competition_id)
    now = datetime.now(timezone.utc)

    await record_audit(
        db, current_operator, "ops.network.restore",
        target_type="team", target_id=team.id,
        details={"reason": body.reason, "subnet": team.subnet},
        ip_address=request.client.host if request.client else None,
    )

    return TeamRestoreResponse(
        team_id=team.id,
        team_name=team.name,
        subnet=team.subnet,
        status="connected",
        message="팀 네트워크 격리가 해제되었습니다.",
        reason=body.reason,
        restored_at=now,
    )


@router.post("/isolate-all")
async def isolate_all_networks(
    competition_id: UUID,
    body: NetworkIsolateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> BulkIsolateResponse:
    """전체 참가자 네트워크를 차단한다 (대회 긴급 중단 시).

    Redis 파이프라인으로 모든 팀을 일괄 격리한다. 실제 iptables는 인프라 담당자 영역.
    """
    comp = await _get_competition_or_404(db, competition_id)
    teams = await _get_approved_teams(db, competition_id)

    if not teams:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="승인된 팀이 없습니다.",
        )

    # 이미 전체 격리 상태인지 한 번에 조회
    isolated_ids = await get_isolated_team_ids(competition_id)
    if all(str(team.id) in isolated_ids for team in teams):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 전체 차단 상태입니다.",
        )

    isolated_at = await isolate_all_teams(
        competition_id=competition_id,
        team_ids=[team.id for team in teams],
        reason=body.reason,
        operator_id=current_operator.id,
    )

    await record_audit(
        db, current_operator, "ops.network.isolate_all",
        target_type="competition", target_id=comp.id,
        details={"reason": body.reason, "affected_teams": len(teams)},
        ip_address=request.client.host if request.client else None,
    )

    return BulkIsolateResponse(
        competition_id=comp.id,
        is_all_isolated=True,
        affected_teams=len(teams),
        message="전체 네트워크가 차단되었습니다.",
        reason=body.reason,
        isolated_at=isolated_at,
    )


@router.post("/restore-all")
async def restore_all_networks(
    competition_id: UUID,
    body: NetworkRestoreRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> BulkRestoreResponse:
    """전체 참가자 네트워크를 복구한다.

    Redis 격리 인덱스를 일괄 해제한다. 실제 iptables는 인프라 담당자 영역.
    """
    comp = await _get_competition_or_404(db, competition_id)
    teams = await _get_approved_teams(db, competition_id)

    if not teams:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="승인된 팀이 없습니다.",
        )

    # 격리된 팀이 하나도 없으면 복구 불가
    isolated_ids = await get_isolated_team_ids(competition_id)
    if not isolated_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="전체 차단 상태가 아닙니다.",
        )

    await restore_all_teams(competition_id, [team.id for team in teams])
    now = datetime.now(timezone.utc)

    await record_audit(
        db, current_operator, "ops.network.restore_all",
        target_type="competition", target_id=comp.id,
        details={"reason": body.reason, "restored_teams": len(teams)},
        ip_address=request.client.host if request.client else None,
    )

    return BulkRestoreResponse(
        competition_id=comp.id,
        is_all_isolated=False,
        restored_teams=len(teams),
        message="전체 네트워크가 복구되었습니다.",
        reason=body.reason,
        restored_at=now,
    )


# ── 서브넷 등록 엔드포인트 ─────────────────────────────────

@router.get("/subnets")
async def get_subnet_list(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin", "operator")),
) -> SubnetListResponse:
    """팀별 서브넷 등록 현황을 조회한다."""
    comp = await _get_competition_or_404(db, competition_id)
    teams = await _get_approved_teams(db, competition_id)

    team_infos: list[TeamSubnetInfo] = []
    assigned_count = 0
    vpn_issued_count = 0

    for team in teams:
        has_subnet = bool(team.subnet)
        if has_subnet:
            assigned_count += 1
        if team.vpn_profile_issued:
            vpn_issued_count += 1

        team_infos.append(TeamSubnetInfo(
            team_id=team.id,
            team_name=team.name,
            team_code=team.team_code,
            subnet=team.subnet,
            gateway_ip=team.gateway_ip,
            vpn_profile_issued=team.vpn_profile_issued,
            registration_status="registered" if has_subnet else "unassigned",
            updated_at=team.updated_at,
        ))

    total = len(teams)
    return SubnetListResponse(
        competition_id=comp.id,
        total_teams=total,
        assigned_count=assigned_count,
        unassigned_count=total - assigned_count,
        vpn_issued_count=vpn_issued_count,
        teams=team_infos,
    )


@router.put("/subnets/{team_id}")
async def assign_team_subnet(
    competition_id: UUID,
    team_id: UUID,
    body: SubnetAssignRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> SubnetAssignResponse:
    """개별 팀에 서브넷을 등록/수정한다."""
    await _get_competition_or_404(db, competition_id)
    team = await _get_team_or_404(db, competition_id, team_id)

    # 같은 대회 내 서브넷 중복 검증
    dup_result = await db.execute(
        select(Team).where(
            Team.competition_id == competition_id,
            Team.subnet == body.subnet,
            Team.id != team_id,
        )
    )
    if dup_result.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"서브넷 {body.subnet}은(는) 이미 다른 팀에 할당되어 있습니다.",
        )

    team.subnet = body.subnet
    team.gateway_ip = body.gateway_ip
    team.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(team)

    await record_audit(
        db, current_operator, "ops.network.subnet.assign",
        target_type="team", target_id=team.id,
        details={"subnet": body.subnet, "gateway_ip": body.gateway_ip},
        ip_address=request.client.host if request.client else None,
    )

    return SubnetAssignResponse(
        team_id=team.id,
        team_name=team.name,
        subnet=team.subnet,
        gateway_ip=team.gateway_ip,
        message=f"팀 '{team.name}'에 서브넷 {body.subnet}이(가) 등록되었습니다.",
    )


@router.post("/subnets/bulk")
async def bulk_assign_subnets(
    competition_id: UUID,
    body: SubnetBulkAssignRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> SubnetListResponse:
    """서브넷을 일괄 등록한다."""
    comp = await _get_competition_or_404(db, competition_id)

    # 요청 내부 서브넷 중복 검증
    seen_subnets: set[str] = set()
    for item in body.assignments:
        if item.subnet in seen_subnets:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"요청 내에 중복 서브넷이 있습니다: {item.subnet}",
            )
        seen_subnets.add(item.subnet)

    # DB 내 기존 서브넷 중복 검증 (요청 대상 팀 제외)
    request_team_ids = {item.team_id for item in body.assignments}
    existing_result = await db.execute(
        select(Team).where(
            Team.competition_id == competition_id,
            Team.subnet.in_(list(seen_subnets)),
            Team.id.notin_(list(request_team_ids)),
        )
    )
    dup_team = existing_result.scalar_one_or_none()
    if dup_team is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"서브넷 {dup_team.subnet}은(는) 이미 팀 '{dup_team.name}'에 할당되어 있습니다.",
        )

    # 각 팀에 서브넷 할당
    now = datetime.now(timezone.utc)
    for item in body.assignments:
        team = await _get_team_or_404(db, competition_id, item.team_id)
        team.subnet = item.subnet
        team.gateway_ip = item.gateway_ip
        team.updated_at = now

    await db.commit()

    await record_audit(
        db, current_operator, "ops.network.subnet.bulk_assign",
        target_type="competition", target_id=comp.id,
        details={"count": len(body.assignments), "subnets": [a.subnet for a in body.assignments]},
        ip_address=request.client.host if request.client else None,
    )

    # 갱신된 전체 현황 반환
    teams = await _get_approved_teams(db, competition_id)
    team_infos: list[TeamSubnetInfo] = []
    assigned_count = 0
    vpn_issued_count = 0
    for team in teams:
        has_subnet = bool(team.subnet)
        if has_subnet:
            assigned_count += 1
        if team.vpn_profile_issued:
            vpn_issued_count += 1
        team_infos.append(TeamSubnetInfo(
            team_id=team.id,
            team_name=team.name,
            team_code=team.team_code,
            subnet=team.subnet,
            gateway_ip=team.gateway_ip,
            vpn_profile_issued=team.vpn_profile_issued,
            registration_status="registered" if has_subnet else "unassigned",
            updated_at=team.updated_at,
        ))

    total = len(teams)
    return SubnetListResponse(
        competition_id=comp.id,
        total_teams=total,
        assigned_count=assigned_count,
        unassigned_count=total - assigned_count,
        vpn_issued_count=vpn_issued_count,
        teams=team_infos,
    )


@router.post("/subnets/auto-assign")
async def auto_assign_subnets(
    competition_id: UUID,
    body: SubnetAutoAssignRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> SubnetAutoAssignResponse:
    """미할당 팀에 서브넷을 자동으로 순차 배정한다."""
    comp = await _get_competition_or_404(db, competition_id)
    teams = await _get_approved_teams(db, competition_id)

    # 이미 사용 중인 서브넷 수집
    used_subnets: set[str] = set()
    unassigned_teams: list[Team] = []
    for team in teams:
        if team.subnet:
            used_subnets.add(team.subnet)
        else:
            unassigned_teams.append(team)

    if not unassigned_teams:
        return SubnetAutoAssignResponse(
            competition_id=comp.id,
            assigned_count=0,
            skipped_count=0,
            assignments=[],
            message="모든 팀에 이미 서브넷이 할당되어 있습니다.",
        )

    # 순차 배정
    now = datetime.now(timezone.utc)
    idx = body.start_index
    assigned_infos: list[TeamSubnetInfo] = []
    skipped = 0

    for team in unassigned_teams:
        # 빈 인덱스 찾기 (사용 중인 서브넷 건너뜀)
        while idx <= 254:
            candidate = f"{body.base_prefix}.{idx}.0/24"
            if candidate not in used_subnets:
                break
            idx += 1
            skipped += 1
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="할당 가능한 서브넷이 부족합니다 (254 초과).",
            )

        subnet = f"{body.base_prefix}.{idx}.0/24"
        gateway = f"{body.base_prefix}.{idx}.1"
        team.subnet = subnet
        team.gateway_ip = gateway
        team.updated_at = now
        used_subnets.add(subnet)

        assigned_infos.append(TeamSubnetInfo(
            team_id=team.id,
            team_name=team.name,
            team_code=team.team_code,
            subnet=subnet,
            gateway_ip=gateway,
            vpn_profile_issued=team.vpn_profile_issued,
            registration_status="registered",
            updated_at=now,
        ))
        idx += 1

    await db.commit()

    await record_audit(
        db, current_operator, "ops.network.subnet.auto_assign",
        target_type="competition", target_id=comp.id,
        details={"assigned": len(assigned_infos), "skipped": skipped, "base_prefix": body.base_prefix},
        ip_address=request.client.host if request.client else None,
    )

    return SubnetAutoAssignResponse(
        competition_id=comp.id,
        assigned_count=len(assigned_infos),
        skipped_count=skipped,
        assignments=assigned_infos,
        message=f"{len(assigned_infos)}개 팀에 서브넷이 자동 할당되었습니다.",
    )


# ── 배포 현황 엔드포인트 ──────────────────────────────────

@router.get("/deploy-status")
async def get_deploy_status(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin", "operator")),
) -> DeployStatusResponse:
    """팀별 배포 현황을 조회한다."""
    comp = await _get_competition_or_404(db, competition_id)
    teams = await _get_approved_teams(db, competition_id)

    team_statuses: list[TeamDeployStatus] = []
    deployed_count = 0
    deploying_count = 0
    pending_count = 0

    for team in teams:
        # 서브넷 미등록
        if not team.subnet:
            team_statuses.append(TeamDeployStatus(
                team_id=team.id,
                team_name=team.name,
                subnet=None,
                vulnpack_name=None,
                deploy_status="no_subnet",
                progress_pct=0,
                last_deploy_at=None,
            ))
            continue

        # 서비스 인스턴스 조회
        services_data = await _get_team_services_with_names(db, team.id)
        total_services = len(services_data)

        if total_services == 0:
            pending_count += 1
            team_statuses.append(TeamDeployStatus(
                team_id=team.id,
                team_name=team.name,
                subnet=team.subnet,
                vulnpack_name=None,
                deploy_status="pending",
                progress_pct=0,
                last_deploy_at=None,
            ))
            continue

        running = sum(1 for ts, _ in services_data if ts.status == "running")
        errored = sum(1 for ts, _ in services_data if ts.status == "error")

        # 마지막 배포 시각 (서비스 인스턴스의 updated_at 중 최신)
        last_deploy = None
        vulnpack_name = None
        for ts, svc_name in services_data:
            if vulnpack_name is None:
                vulnpack_name = svc_name
            if ts.updated_at is not None:
                if last_deploy is None or ts.updated_at > last_deploy:
                    last_deploy = ts.updated_at

        # 상태 판단
        if errored > 0:
            deploy_st = "failed"
            progress = int((running / total_services) * 100) if total_services > 0 else 0
        elif running == total_services:
            deploy_st = "completed"
            progress = 100
            deployed_count += 1
        elif running > 0:
            deploy_st = "deploying"
            progress = int((running / total_services) * 100)
            deploying_count += 1
        else:
            deploy_st = "pending"
            progress = 0
            pending_count += 1

        team_statuses.append(TeamDeployStatus(
            team_id=team.id,
            team_name=team.name,
            subnet=team.subnet,
            vulnpack_name=vulnpack_name,
            deploy_status=deploy_st,
            progress_pct=progress,
            last_deploy_at=last_deploy,
        ))

    return DeployStatusResponse(
        competition_id=comp.id,
        total_teams=len(teams),
        deployed_count=deployed_count,
        deploying_count=deploying_count,
        pending_count=pending_count,
        teams=team_statuses,
    )
