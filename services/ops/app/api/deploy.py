"""배포 파이프라인 API 라우터 -- 파이프라인 CRUD, 롤백, 단계 재시도."""

import logging
from datetime import datetime, timezone
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import delete as sa_delete, select, update as sa_update, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.api.deps import get_current_operator, require_role
from app.models.operator import Operator
from app.models.deploy import DeployPipeline, DeployStage
from app.models.team import Team
from app.models.vuln_service import VulnService
from app.schemas.deploy import (
    DeployCreate,
    DeployPipelineResponse,
    DeployStageResponse,
    PipelineListResponse,
)
from app.utils.audit import record_audit
from app.utils.crypto import decrypt_password

logger = logging.getLogger(__name__)

router = APIRouter(tags=["배포"])

# ── 배포 파이프라인 5단계 정의 ──────────────────────────────────

PIPELINE_STAGES = [
    {"stage_order": 1, "stage_name": "register"},
    {"stage_order": 2, "stage_name": "validate"},
    {"stage_order": 3, "stage_name": "prepare"},
    {"stage_order": 4, "stage_name": "deploy"},
    {"stage_order": 5, "stage_name": "verify"},
]


def _build_stages(pipeline_id, *, start_immediately: bool = True) -> list[DeployStage]:
    """파이프라인에 속하는 5개 단계 ORM 객체를 생성한다."""
    now = datetime.now(timezone.utc)
    stages: list[DeployStage] = []
    for defn in PIPELINE_STAGES:
        is_first = start_immediately and defn["stage_order"] == 1
        stage = DeployStage(
            pipeline_id=pipeline_id,
            stage_name=defn["stage_name"],
            stage_order=defn["stage_order"],
            status="running" if is_first else "pending",
            started_at=now if is_first else None,
        )
        stages.append(stage)
    return stages


async def activate_scheduled_pipeline(
    db: AsyncSession,
    pipeline: DeployPipeline,
) -> None:
    """scheduled 파이프라인을 running으로 전환하고 첫 단계를 시작 상태로 만든다."""
    if pipeline.status != "scheduled":
        return

    now = datetime.now(timezone.utc)
    pipeline.status = "running"
    pipeline.current_stage = "register"
    pipeline.started_at = now
    pipeline.completed_at = None
    pipeline.error_detail = None

    await db.execute(
        sa_update(DeployStage)
        .where(DeployStage.pipeline_id == pipeline.id)
        .values(
            status="pending",
            started_at=None,
            completed_at=None,
            error_detail=None,
        )
    )
    await db.execute(
        sa_update(DeployStage)
        .where(
            DeployStage.pipeline_id == pipeline.id,
            DeployStage.stage_name == "register",
        )
        .values(
            status="running",
            started_at=now,
            completed_at=None,
            error_detail=None,
        )
    )


async def _resolve_names(
    db: AsyncSession,
    operator_ids: set[UUID],
    service_ids: set[UUID],
) -> tuple[dict[UUID, str], dict[UUID, str]]:
    """operator/service UUID → display_name/name 매핑을 반환한다."""
    op_map: dict[UUID, str] = {}
    svc_map: dict[UUID, str] = {}
    if operator_ids:
        result = await db.execute(
            select(Operator.id, Operator.display_name).where(
                Operator.id.in_(operator_ids)
            )
        )
        op_map = {row.id: row.display_name for row in result.all()}
    if service_ids:
        result = await db.execute(
            select(VulnService.id, VulnService.name).where(
                VulnService.id.in_(service_ids)
            )
        )
        svc_map = {row.id: row.name for row in result.all()}
    return op_map, svc_map


async def _get_approved_teams_or_raise(
    db: AsyncSession, service: VulnService
) -> list[Team]:
    """서비스가 속한 대회의 approved 팀 목록을 반환. 대회 미지정/팀 0명이면 400.

    배포 파이프라인은 "승인된 팀별 컨테이너 생성"을 핵심으로 하므로,
    대회에 연결되지 않았거나 승인된 팀이 없으면 의미 없는 빈 배포 로그
    (예: "0개 팀 네트워크 준비 완료", "0/0개 팀 배포 완료")가 남는다.
    운영 플로우 오류를 사용자에게 즉시 알리기 위해 시작 시점에 거부한다.
    """
    if service.competition_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이 서비스는 대회에 연결되어 있지 않아 배포할 수 없습니다. 서비스에 대회를 지정하거나 대회별 서비스로 다시 등록해 주세요.",
        )
    result = await db.execute(
        select(Team).where(
            Team.competition_id == service.competition_id,
            Team.status == "approved",
        )
    )
    teams = list(result.scalars().all())
    if not teams:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="해당 대회에 승인된 팀이 없습니다. 팀을 등록/승인한 뒤 다시 시도해 주세요.",
        )
    return teams


def _build_team_payload(teams: list[Team]) -> list[dict]:
    """deploy-service /deploy/teams 요청 바디용 팀 리스트를 만든다."""
    return [
        {
            "team_id": str(t.id),
            "team_code": t.team_code,
            "name": t.name,
            "subnet": t.subnet,
            "gateway_ip": getattr(t, "gateway_ip", None),
            "competition_id": str(t.competition_id),
            "ssh_port": t.ssh_port or 22,
            "ssh_user": t.ssh_user,
            "ssh_password": decrypt_password(t.ssh_password) if t.ssh_password else None,
        }
        for t in teams
    ]


def _build_service_payload(service: VulnService) -> dict:
    """deploy-service /deploy/teams 요청 바디용 서비스 정보를 만든다."""
    compose_cfg = service.docker_compose_config or {}
    env_vars = compose_cfg.get("environment") if compose_cfg else None
    return {
        "service_id": str(service.id),
        "name": service.name,
        "docker_image": service.docker_image,
        "container_port": service.container_port or 80,
        "health_check_endpoint": service.health_check_endpoint,
        "healthcheck_scenarios": service.healthcheck_scenarios,
        "env_vars": env_vars,
        "flag_slots": service.flag_slots,
    }


async def _dispatch_deployment(
    db: AsyncSession,
    pipeline: DeployPipeline,
    service: VulnService,
    teams: list[Team],
) -> None:
    """deploy-service에 실제 배포를 위임한다. 호출 실패 시 파이프라인을 failed로 마크."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{settings.DEPLOY_SERVICE_URL}/deploy/teams",
                json={
                    "pipeline_id": str(pipeline.id),
                    "service": _build_service_payload(service),
                    "teams": _build_team_payload(teams),
                },
                headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
            )
        if resp.status_code not in (200, 202):
            pipeline.status = "failed"
            pipeline.error_detail = f"deploy-service 호출 실패: {resp.text}"
            await db.commit()
    except Exception as e:
        pipeline.status = "failed"
        pipeline.error_detail = f"deploy-service 연결 실패: {e}"
        await db.commit()



# ── 엔드포인트 ────────────────────────────────────────────────


@router.get("/pipelines")
async def list_pipelines(
    request: Request,
    status_filter: str | None = Query(None, alias="status"),
    service_id: str | None = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """배포 파이프라인 목록을 조회한다."""
    base_query = select(DeployPipeline)

    if status_filter:
        base_query = base_query.where(DeployPipeline.status == status_filter)
    if service_id:
        base_query = base_query.where(DeployPipeline.service_id == service_id)

    count_result = await db.execute(select(sa_func.count()).select_from(base_query.subquery()))
    total = count_result.scalar() or 0

    data_query = (
        base_query.order_by(DeployPipeline.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )

    result = await db.execute(data_query)
    pipelines = result.scalars().all()

    # operator/service 이름 일괄 조회
    op_ids = {p.triggered_by for p in pipelines}
    svc_ids = {p.service_id for p in pipelines}
    op_map, svc_map = await _resolve_names(db, op_ids, svc_ids)

    items = []
    for p in pipelines:
        resp = PipelineListResponse.model_validate(p)
        resp.triggered_by_name = op_map.get(p.triggered_by)
        resp.service_name = svc_map.get(p.service_id)
        items.append(resp)

    return {"items": items, "total": total}


@router.post("/pipelines", response_model=DeployPipelineResponse)
async def start_pipeline(
    body: DeployCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """새 배포 파이프라인을 시작한다.

    대상 서비스가 active 상태이고, 해당 대회에 승인된 팀이 1개 이상 있어야 한다.
    승인 팀이 없으면 0/0 팀 배포라는 의미 없는 빈 로그가 남으므로 시작 시점에 거부한다.
    scheduled_for가 미래 시각이면 예약 배포 파이프라인을 만들고, 해당 시각에 자동 실행된다.
    그 외에는 즉시 5개 단계가 자동 생성되고 deploy-service가 실제 배포를 진행한다.
    """
    # 1) 서비스 존재 및 상태 검증
    svc_result = await db.execute(
        select(VulnService).where(VulnService.id == body.service_id)
    )
    service = svc_result.scalar_one_or_none()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 서비스를 찾을 수 없습니다.",
        )
    if service.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="활성(active) 상태의 서비스만 배포할 수 있습니다. (빌드 성공 후 자동 전환됩니다)",
        )

    # 2) 승인된 팀 가드 — 빈 배포 방지
    teams = await _get_approved_teams_or_raise(db, service)

    # 3) 파이프라인 생성
    now = datetime.now(timezone.utc)
    scheduled_for = body.scheduled_for
    start_immediately = scheduled_for is None or scheduled_for <= now
    pipeline = DeployPipeline(
        service_id=service.id,
        triggered_by=current_operator.id,
        status="running" if start_immediately else "scheduled",
        current_stage="register" if start_immediately else None,
        scheduled_for=scheduled_for if not start_immediately else None,
        started_at=now if start_immediately else None,
    )
    db.add(pipeline)
    await db.flush()  # pipeline.id 확보

    # 4) 5개 단계 자동 생성
    stages = _build_stages(pipeline.id, start_immediately=start_immediately)
    db.add_all(stages)

    # 5) 감사 로그
    await record_audit(
        db, current_operator, "ops.deploy.start",
        "pipeline", pipeline.id,
        {
            "service_id": str(body.service_id),
            "team_count": len(teams),
            "mode": "immediate" if start_immediately else "scheduled",
            "scheduled_for": scheduled_for.isoformat() if scheduled_for and not start_immediately else None,
        },
        request.client.host if request.client else None,
    )
    await db.commit()

    # 6) 즉시 배포일 때만 deploy-service에 실제 배포 위임
    if start_immediately:
        await _dispatch_deployment(db, pipeline, service, teams)

    # 7) 응답 조립
    await db.refresh(pipeline)
    stage_rows = await _fetch_stages(db, pipeline.id)
    op_map = {current_operator.id: current_operator.display_name}
    svc_map = {service.id: service.name}
    return _to_pipeline_response(pipeline, stage_rows, op_map, svc_map)


@router.get("/pipelines/{pipeline_id}", response_model=DeployPipelineResponse)
async def get_pipeline(
    pipeline_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """파이프라인 상세와 5단계 진행 상태를 조회한다."""
    result = await db.execute(
        select(DeployPipeline).where(DeployPipeline.id == pipeline_id)
    )
    pipeline = result.scalar_one_or_none()
    if pipeline is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 파이프라인을 찾을 수 없습니다.",
        )

    stage_rows = await _fetch_stages(db, pipeline.id)
    op_map, svc_map = await _resolve_names(
        db, {pipeline.triggered_by}, {pipeline.service_id},
    )
    return _to_pipeline_response(pipeline, stage_rows, op_map, svc_map)


@router.delete("/pipelines/{pipeline_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pipeline(
    pipeline_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """배포 파이프라인 레코드를 삭제한다.

    실행 중(running) 상태는 삭제를 거부해 진행 중 작업 유실을 방지한다.
    stages는 명시 삭제, rollback_of로 이 파이프라인을 참조하는 후속 파이프라인은
    rollback_of를 NULL로 초기화해 FK 위반을 피한다.
    실제 컨테이너/이미지는 건드리지 않으며 레코드 정리 전용이다.
    """
    result = await db.execute(
        select(DeployPipeline).where(DeployPipeline.id == pipeline_id)
    )
    pipeline = result.scalar_one_or_none()
    if pipeline is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 파이프라인을 찾을 수 없습니다.",
        )
    if pipeline.status == "running":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="실행 중(running) 상태의 파이프라인은 삭제할 수 없습니다. 완료 또는 실패 후 재시도해 주세요.",
        )

    # rollback_of로 이 파이프라인을 가리키는 후속 파이프라인의 참조 해제
    await db.execute(
        sa_update(DeployPipeline)
        .where(DeployPipeline.rollback_of == pipeline_id)
        .values(rollback_of=None)
    )
    # 자식 stages 삭제
    await db.execute(
        sa_delete(DeployStage).where(DeployStage.pipeline_id == pipeline_id)
    )
    # 파이프라인 삭제
    await db.execute(
        sa_delete(DeployPipeline).where(DeployPipeline.id == pipeline_id)
    )

    await record_audit(
        db, current_operator, "ops.deploy.delete",
        "pipeline", pipeline.id,
        {"status_at_delete": pipeline.status},
        request.client.host if request.client else None,
    )
    await db.commit()


@router.post("/pipelines/{pipeline_id}/rollback", response_model=DeployPipelineResponse)
async def rollback_pipeline(
    pipeline_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """완료/실패한 파이프라인에 대해 롤백 파이프라인을 생성한다.

    C-STRIKE는 서비스당 단일 이미지를 유지하므로 "롤백"은 의미상 "현재 이미지로 재배포"
    (=기존 팀별 컨테이너를 중지/제거 후 동일 이미지로 재생성)다. 문제 대응용 수복 동작.
    start_pipeline과 동일하게 approved 팀 가드를 적용하고 deploy-service를 실제 호출한다.
    """
    # 1) 원본 파이프라인 조회
    result = await db.execute(
        select(DeployPipeline).where(DeployPipeline.id == pipeline_id)
    )
    original = result.scalar_one_or_none()
    if original is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 파이프라인을 찾을 수 없습니다.",
        )
    if original.status not in ("success", "failed"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="완료(success) 또는 실패(failed) 상태의 파이프라인만 롤백할 수 있습니다.",
        )

    # 2) 원본 서비스 조회 (active 여부 확인, 이미지 메타 필요)
    svc_result = await db.execute(
        select(VulnService).where(VulnService.id == original.service_id)
    )
    service = svc_result.scalar_one_or_none()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="원본 서비스가 더 이상 존재하지 않아 롤백할 수 없습니다.",
        )
    if service.status != "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="원본 서비스가 활성(active) 상태가 아니어서 롤백할 수 없습니다.",
        )

    # 3) 승인된 팀 가드
    teams = await _get_approved_teams_or_raise(db, service)

    # 4) 롤백 파이프라인 생성
    now = datetime.now(timezone.utc)
    rollback = DeployPipeline(
        service_id=original.service_id,
        triggered_by=current_operator.id,
        status="running",
        current_stage="register",
        started_at=now,
        rollback_of=original.id,
    )
    db.add(rollback)
    await db.flush()

    # 5) 5개 단계 자동 생성
    stages = _build_stages(rollback.id)
    db.add_all(stages)

    await record_audit(
        db, current_operator, "ops.deploy.rollback",
        "pipeline", rollback.id,
        {"original_pipeline_id": str(pipeline_id), "team_count": len(teams)},
        request.client.host if request.client else None,
    )
    await db.commit()

    # 6) deploy-service에 실제 재배포 위임 — start_pipeline과 동일 경로
    await _dispatch_deployment(db, rollback, service, teams)

    # 7) 응답 조립
    await db.refresh(rollback)
    stage_rows = await _fetch_stages(db, rollback.id)
    op_map = {current_operator.id: current_operator.display_name}
    _, svc_map = await _resolve_names(db, set(), {original.service_id})
    return _to_pipeline_response(rollback, stage_rows, op_map, svc_map)


@router.post("/pipelines/{pipeline_id}/stages/{stage_name}/retry")
async def retry_stage(
    pipeline_id: str,
    stage_name: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """실패한 단계를 재시도한다. status를 running으로 복원한다."""
    # 파이프라인 존재 확인
    pipe_result = await db.execute(
        select(DeployPipeline).where(DeployPipeline.id == pipeline_id)
    )
    pipeline = pipe_result.scalar_one_or_none()
    if pipeline is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 파이프라인을 찾을 수 없습니다.",
        )

    # 해당 단계 조회
    stage_result = await db.execute(
        select(DeployStage).where(
            DeployStage.pipeline_id == pipeline_id,
            DeployStage.stage_name == stage_name,
        )
    )
    stage = stage_result.scalar_one_or_none()
    if stage is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"'{stage_name}' 단계를 찾을 수 없습니다.",
        )
    if stage.status != "failed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="실패(failed) 상태의 단계만 재시도할 수 있습니다.",
        )

    # 상태 복원
    stage.status = "running"
    stage.started_at = datetime.now(timezone.utc)
    stage.error_detail = None

    await record_audit(
        db, current_operator, "ops.deploy.retry_stage",
        "stage", stage.id,
        {"pipeline_id": str(pipeline_id), "stage_name": stage_name},
        request.client.host if request.client else None,
    )
    await db.commit()

    return DeployStageResponse.model_validate(stage)


@router.post("/pipelines/{pipeline_id}/stages/{stage_name}/advance")
async def advance_stage(
    pipeline_id: str,
    stage_name: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """실행 중인 단계를 완료하고 다음 단계로 진행한다.

    마지막 단계를 완료하면 파이프라인 전체가 success로 전환된다.
    """
    # 파이프라인 조회
    pipe_result = await db.execute(
        select(DeployPipeline).where(DeployPipeline.id == pipeline_id)
    )
    pipeline = pipe_result.scalar_one_or_none()
    if pipeline is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 파이프라인을 찾을 수 없습니다.",
        )

    # 현재 단계 조회
    stage_result = await db.execute(
        select(DeployStage).where(
            DeployStage.pipeline_id == pipeline_id,
            DeployStage.stage_name == stage_name,
        )
    )
    current_stage = stage_result.scalar_one_or_none()
    if current_stage is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"'{stage_name}' 단계를 찾을 수 없습니다.",
        )
    if current_stage.status != "running":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="실행 중(running) 상태의 단계만 완료할 수 있습니다.",
        )
    if stage_name != pipeline.current_stage:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"현재 진행 중인 단계({pipeline.current_stage})만 완료할 수 있습니다.",
        )

    now = datetime.now(timezone.utc)

    # 현재 단계 완료 처리
    current_stage.status = "success"
    current_stage.completed_at = now

    # 다음 단계 조회
    next_result = await db.execute(
        select(DeployStage).where(
            DeployStage.pipeline_id == pipeline_id,
            DeployStage.stage_order == current_stage.stage_order + 1,
        )
    )
    next_stage = next_result.scalar_one_or_none()

    if next_stage:
        # 다음 단계 시작
        next_stage.status = "running"
        next_stage.started_at = now
        pipeline.current_stage = next_stage.stage_name
    else:
        # 마지막 단계 — 파이프라인 완료
        pipeline.status = "success"
        pipeline.completed_at = now
        pipeline.current_stage = None

    await record_audit(
        db, current_operator, "ops.deploy.advance_stage",
        "stage", current_stage.id,
        {
            "pipeline_id": str(pipeline_id),
            "completed_stage": stage_name,
            "next_stage": next_stage.stage_name if next_stage else None,
        },
        request.client.host if request.client else None,
    )
    await db.commit()

    # 전체 파이프라인 응답 반환
    await db.refresh(pipeline)
    stage_rows = await _fetch_stages(db, pipeline.id)
    op_map, svc_map = await _resolve_names(
        db, {pipeline.triggered_by}, {pipeline.service_id},
    )
    return _to_pipeline_response(pipeline, stage_rows, op_map, svc_map)


# ── 내부 헬퍼 ─────────────────────────────────────────────────


async def _fetch_stages(db: AsyncSession, pipeline_id) -> list[DeployStage]:
    """파이프라인에 속하는 단계 목록을 stage_order 순으로 반환한다."""
    result = await db.execute(
        select(DeployStage)
        .where(DeployStage.pipeline_id == pipeline_id)
        .order_by(DeployStage.stage_order)
    )
    return list(result.scalars().all())


def _to_pipeline_response(
    pipeline: DeployPipeline,
    stages: list[DeployStage],
    op_map: dict[UUID, str] | None = None,
    svc_map: dict[UUID, str] | None = None,
) -> DeployPipelineResponse:
    """ORM 파이프라인 + 단계 목록을 Pydantic 응답으로 변환한다."""
    resp = DeployPipelineResponse.model_validate(pipeline)
    resp.stages = [DeployStageResponse.model_validate(s) for s in stages]
    if op_map:
        resp.triggered_by_name = op_map.get(pipeline.triggered_by)
    if svc_map:
        resp.service_name = svc_map.get(pipeline.service_id)
    return resp
