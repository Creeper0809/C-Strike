"""비상 통제 API 라우터 -- 전체/채점/서비스 중단, 재개, 이력 조회."""

from datetime import datetime, timezone
from uuid import UUID as PyUUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator, require_role
from app.models.operator import Operator
from app.models.emergency import EmergencyAction
from app.models.vuln_service import VulnService
from app.schemas.emergency import (
    EmergencyHaltRequest,
    EmergencyHaltServiceRequest,
    EmergencyResumeRequest,
    EmergencyActionResponse,
    EmergencyStatusResponse,
)
from app.utils.audit import record_audit
from app.redis_client import get_redis

import json
import logging

logger = logging.getLogger(__name__)

router = APIRouter(tags=["비상 통제"])


# ── operator 이름 조회 헬퍼 ───────────────────────────────────


async def _resolve_operator_names(
    db: AsyncSession, operator_ids: set,
) -> dict:
    """operator UUID 집합 → {id: display_name} 매핑을 반환한다."""
    if not operator_ids:
        return {}
    result = await db.execute(
        select(Operator.id, Operator.display_name).where(
            Operator.id.in_(operator_ids)
        )
    )
    return {row.id: row.display_name for row in result.all()}


def _enrich_action(
    action: EmergencyAction,
    name_map: dict,
) -> EmergencyActionResponse:
    """EmergencyAction ORM에 이름을 채운 응답을 반환한다."""
    resp = EmergencyActionResponse.model_validate(action)
    resp.executed_by_name = name_map.get(action.executed_by)
    if action.reverted_by:
        resp.reverted_by_name = name_map.get(action.reverted_by)
    return resp


# ── 외부 시스템 호출 헬퍼 ──────────────────────────────────────


async def _call_scoring_pause(reason: str):
    """채점 엔진에 일시중지 Redis 이벤트를 발행한다. 실패해도 예외를 전파하지 않는다."""
    try:
        redis = await get_redis()
        payload = json.dumps({"type": "graceful", "reason": reason}, ensure_ascii=False)
        await redis.publish("emergency:halt", payload)
    except Exception as e:
        logger.warning("채점 일시중지 Redis 발행 실패: %s", e)


async def _call_scoring_resume(reason: str):
    """채점 엔진에 재개 Redis 이벤트를 발행한다. 실패해도 예외를 전파하지 않는다."""
    try:
        redis = await get_redis()
        payload = json.dumps({"type": "resume", "reason": reason}, ensure_ascii=False)
        await redis.publish("emergency:resume", payload)
    except Exception as e:
        logger.warning("채점 재개 Redis 발행 실패: %s", e)


async def _notify_discord(action_type: str, reason: str, severity: str = "critical"):
    """Discord에 비상 조치 공지를 전송한다. 실패해도 예외를 전파하지 않는다."""
    title_map = {
        "halt_all": "[비상] 전체 시스템 중단",
        "halt_scoring": "[비상] 채점 시스템 중단",
        "halt_service": "[비상] 서비스 중단",
        "resume": "[복구] 시스템 재개",
    }
    try:
        client = ExternalClient(settings.DISCORD_BOT_URL)
        await client.post("/api/discord/notify-incident", json_data={
            "incident_type": action_type,
            "title": title_map.get(action_type, f"[비상] {action_type}"),
            "details": reason,
            "severity": severity,
        })
    except Exception as e:
        logger.warning("Discord 비상 공지 전송 실패: %s", e)


# ── 엔드포인트 ────────────────────────────────────────────────


@router.get("/status", response_model=EmergencyStatusResponse)
async def get_emergency_status(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """현재 비상 상태를 조회한다. 활성(reverted_at IS NULL) 조치가 있으면 is_halted=True."""
    result = await db.execute(
        select(EmergencyAction).where(EmergencyAction.reverted_at.is_(None))
    )
    active_actions = list(result.scalars().all())

    if not active_actions:
        return EmergencyStatusResponse(
            is_halted=False,
            halt_type=None,
            active_actions=[],
        )

    # halt_type 결정: halt_all > halt_scoring > halt_service
    halt_type = _determine_halt_type(active_actions)

    operator_ids = {a.executed_by for a in active_actions}
    operator_ids |= {a.reverted_by for a in active_actions if a.reverted_by}
    name_map = await _resolve_operator_names(db, operator_ids)

    return EmergencyStatusResponse(
        is_halted=True,
        halt_type=halt_type,
        active_actions=[
            _enrich_action(a, name_map) for a in active_actions
        ],
    )


@router.post(
    "/halt",
    response_model=EmergencyActionResponse,
    dependencies=[Depends(require_role("admin"))],
)
async def halt_all(
    body: EmergencyHaltRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """전체 시스템을 비상 중단한다. admin 역할만 가능."""
    action = EmergencyAction(
        action_type="halt_all",
        reason=body.reason,
        executed_by=current_operator.id,
    )
    db.add(action)
    await db.flush()

    # 외부 시스템 연동 (실패해도 계속)
    await _call_scoring_pause(body.reason)
    await _notify_discord("halt_all", body.reason)

    await record_audit(
        db, current_operator, "ops.emergency.halt_all",
        "emergency_action", action.id,
        {"reason": body.reason},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(action)

    name_map = {current_operator.id: current_operator.display_name}
    return _enrich_action(action, name_map)


@router.post(
    "/halt-scoring",
    response_model=EmergencyActionResponse,
    dependencies=[Depends(require_role("admin"))],
)
async def halt_scoring(
    body: EmergencyHaltRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """채점 시스템만 비상 중단한다. admin 역할만 가능."""
    action = EmergencyAction(
        action_type="halt_scoring",
        reason=body.reason,
        executed_by=current_operator.id,
    )
    db.add(action)
    await db.flush()

    await _call_scoring_pause(body.reason)
    await _notify_discord("halt_scoring", body.reason)

    await record_audit(
        db, current_operator, "ops.emergency.halt_scoring",
        "emergency_action", action.id,
        {"reason": body.reason},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(action)

    name_map = {current_operator.id: current_operator.display_name}
    return _enrich_action(action, name_map)


@router.post(
    "/halt-service/{service_id}",
    response_model=EmergencyActionResponse,
    dependencies=[Depends(require_role("admin"))],
)
async def halt_service(
    service_id: str,
    body: EmergencyHaltServiceRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """특정 서비스를 비상 중단한다. admin 역할만 가능."""
    # 서비스 존재 확인
    svc_result = await db.execute(
        select(VulnService).where(VulnService.id == service_id)
    )
    if svc_result.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 서비스를 찾을 수 없습니다.",
        )

    action = EmergencyAction(
        action_type="halt_service",
        target_service_id=service_id,
        reason=body.reason,
        executed_by=current_operator.id,
    )
    db.add(action)
    await db.flush()

    await _notify_discord("halt_service", body.reason)

    await record_audit(
        db, current_operator, "ops.emergency.halt_service",
        "emergency_action", action.id,
        {"service_id": str(service_id), "reason": body.reason},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(action)

    name_map = {current_operator.id: current_operator.display_name}
    return _enrich_action(action, name_map)


@router.post(
    "/resume",
    response_model=list[EmergencyActionResponse],
    dependencies=[Depends(require_role("admin"))],
)
async def resume(
    body: EmergencyResumeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """모든 활성 비상 조치를 해제(재개)한다. admin 역할만 가능."""
    result = await db.execute(
        select(EmergencyAction).where(EmergencyAction.reverted_at.is_(None))
    )
    active_actions = list(result.scalars().all())

    if not active_actions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="현재 활성화된 비상 조치가 없습니다.",
        )

    now = datetime.now(timezone.utc)
    for action in active_actions:
        action.reverted_at = now
        action.reverted_by = current_operator.id

    # 외부 시스템 연동 (실패해도 계속)
    await _call_scoring_resume(body.reason)
    await _notify_discord("resume", body.reason, severity="info")

    await record_audit(
        db, current_operator, "ops.emergency.resume",
        "emergency_action", None,
        {"reason": body.reason, "reverted_count": len(active_actions)},
        request.client.host if request.client else None,
    )
    await db.commit()

    # refresh 후 응답
    for action in active_actions:
        await db.refresh(action)

    operator_ids = {a.executed_by for a in active_actions}
    operator_ids |= {a.reverted_by for a in active_actions if a.reverted_by}
    name_map = await _resolve_operator_names(db, operator_ids)

    return [_enrich_action(a, name_map) for a in active_actions]


@router.get("/history")
async def list_history(
    request: Request,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """비상 조치 이력을 최신순으로 조회한다."""
    count_result = await db.execute(select(sa_func.count()).select_from(EmergencyAction))
    total = count_result.scalar() or 0

    result = await db.execute(
        select(EmergencyAction)
        .order_by(EmergencyAction.executed_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    actions = list(result.scalars().all())

    operator_ids = {a.executed_by for a in actions}
    operator_ids |= {a.reverted_by for a in actions if a.reverted_by}
    name_map = await _resolve_operator_names(db, operator_ids)

    return {
        "items": [_enrich_action(a, name_map) for a in actions],
        "total": total,
    }


# ── 내부 헬퍼 ─────────────────────────────────────────────────


def _determine_halt_type(actions: list[EmergencyAction]) -> str:
    """활성 조치 목록에서 가장 높은 우선순위의 halt_type을 결정한다.

    우선순위: halt_all > halt_scoring > halt_service
    """
    types = {a.action_type for a in actions}
    if "halt_all" in types:
        return "all"
    if "halt_scoring" in types:
        return "scoring"
    return "service"
