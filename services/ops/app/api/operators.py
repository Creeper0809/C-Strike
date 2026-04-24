"""운영자(Operator) CRUD API 라우터 — 목록/생성/수정/비활성화.

외주 Discord 봇과의 운영진 역할 Push/Revoke 연동은 teams.py의 팀 역할 패턴을
그대로 복제한다: 봇 호출 실패는 경고 로그로만 남기고 DB 트랜잭션은 계속 진행한다.
"""

import logging
import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_operator, require_role
from app.database import get_db
from app.external import discord_client
from app.models.operator import Operator
from app.schemas.operators import (
    OperatorCreateRequest,
    OperatorCreateResponse,
    OperatorListResponse,
    OperatorResponse,
    OperatorUpdateRequest,
)
from app.utils.audit import record_audit
from app.utils.security import hash_password

router = APIRouter(tags=["운영자 관리"])
logger = logging.getLogger("ops.operators")


# ── 헬퍼 함수 ────────────────────────────────────────────

async def _get_operator_or_404(db: AsyncSession, operator_id: UUID) -> Operator:
    """ID로 운영자를 조회하거나 404를 던진다."""
    result = await db.execute(select(Operator).where(Operator.id == operator_id))
    target = result.scalar_one_or_none()
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="운영자를 찾을 수 없습니다.",
        )
    return target


async def _count_active_admins(db: AsyncSession, exclude_id: UUID | None = None) -> int:
    """활성 admin 수를 카운트한다. exclude_id가 주어지면 해당 레코드는 제외."""
    query = select(func.count()).select_from(Operator).where(
        Operator.role == "admin",
        Operator.is_active.is_(True),
    )
    if exclude_id is not None:
        query = query.where(Operator.id != exclude_id)
    return (await db.execute(query)).scalar_one()


async def _safe_grant_operator_role(discord_user_id: str) -> None:
    """Discord 봇에 운영진 역할 부여 요청 — 실패해도 DB 트랜잭션은 계속 진행."""
    try:
        await discord_client.grant_operator_role(discord_user_id)
    except Exception as exc:
        logger.warning(
            "Discord 운영진 역할 부여 실패 (discord_user_id=%s): %s. "
            "관리자가 Discord에서 수동으로 역할 부여 필요.",
            discord_user_id, exc,
        )


async def _safe_revoke_operator_role(discord_user_id: str) -> None:
    """Discord 봇에 운영진 역할 회수 요청 — 실패해도 DB 트랜잭션은 계속 진행."""
    try:
        await discord_client.revoke_operator_role(discord_user_id)
    except Exception as exc:
        logger.warning(
            "Discord 운영진 역할 회수 실패 (discord_user_id=%s): %s. "
            "관리자가 Discord에서 수동으로 역할 정리 필요.",
            discord_user_id, exc,
        )


async def _resolve_unique_username(db: AsyncSession, base: str) -> str:
    """username 중복을 피하기 위해 `_1`, `_2` suffix를 순차 부여한다.

    base 자체가 비어있지 않다고 가정. 최대 100회까지만 시도.
    """
    candidate = base
    suffix = 0
    while suffix < 100:
        exists = await db.execute(
            select(Operator.id).where(Operator.username == candidate)
        )
        if exists.scalar_one_or_none() is None:
            return candidate
        suffix += 1
        candidate = f"{base}_{suffix}"
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="사용 가능한 username을 생성할 수 없습니다. 관리자에게 문의하세요.",
    )


# ── 엔드포인트 ───────────────────────────────────────────

@router.get("")
async def list_operators(
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> OperatorListResponse:
    """전체 운영자 목록 조회. admin/operator 모두 접근 허용."""
    result = await db.execute(
        select(Operator).order_by(Operator.created_at.asc())
    )
    operators = result.scalars().all()
    items = [OperatorResponse.model_validate(op) for op in operators]
    return OperatorListResponse(items=items, total=len(items))


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_operator(
    body: OperatorCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> OperatorCreateResponse:
    """운영자 신규 생성 (admin 전용).

    UX 단순화: 필수 입력은 discord_user_id + display_name만.
      - username 미제공 시: 'op_{discord_user_id}' 기본, 충돌 시 `_1`, `_2` suffix.
      - password 미제공 시: secrets.token_urlsafe(12) 랜덤 생성, 응답에 1회만 포함.
      - role 미제공 시: 'operator' 기본.
    discord_user_id는 필수 — 생성 후 Discord 봇에 '운영진' 역할 부여를 요청한다.
    봇 호출 실패 시 경고 로그만 남기고 DB 생성은 계속 진행한다.
    """
    # username 결정: 제공된 값 우선, 없으면 'op_{discord_user_id}' 기본 + 중복 시 suffix
    if body.username is not None:
        requested = body.username.strip()
        exists = await db.execute(
            select(Operator.id).where(Operator.username == requested)
        )
        if exists.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="해당 username은 이미 사용 중입니다.",
            )
        final_username = requested
    else:
        final_username = await _resolve_unique_username(
            db, base=f"op_{body.discord_user_id}"
        )

    # password 결정: 제공되면 그대로, 없으면 랜덤 생성 (응답에 1회 반환)
    generated_password: str | None = None
    if body.password is not None:
        plain_password = body.password
    else:
        plain_password = secrets.token_urlsafe(12)
        generated_password = plain_password

    new_op = Operator(
        username=final_username,
        password_hash=hash_password(plain_password),
        display_name=body.display_name,
        role=body.role,
        is_active=True,
        discord_user_id=body.discord_user_id,
    )
    db.add(new_op)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.operator.create",
        target_type="operator", target_id=new_op.id,
        details={
            "username": new_op.username,
            "role": new_op.role,
            "discord_linked": bool(new_op.discord_user_id),
            "auto_username": body.username is None,
            "auto_password": generated_password is not None,
        },
        ip_address=request.client.host if request.client else None,
    )

    # Discord 봇에 '운영진' 역할 부여 요청 (실패해도 생성은 성공 — 견고성)
    if new_op.discord_user_id:
        await _safe_grant_operator_role(new_op.discord_user_id)

    response = OperatorCreateResponse.model_validate(new_op)
    response.generated_password = generated_password
    return response


@router.patch("/{operator_id}")
async def update_operator(
    operator_id: UUID,
    body: OperatorUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> OperatorResponse:
    """운영자 정보 수정 (admin 전용, self 수정 허용).

    discord_user_id 변경 시:
      - 기존 값이 있으면 revoke 호출 후 새 값이 있으면 grant 호출.
      - 새 값이 빈 문자열/null이면 기존 값만 revoke (연동 해제).
    is_active가 False로 전환되면 현재 discord_user_id에 대해 revoke 호출.
    is_active가 True로 전환되면 현재 discord_user_id에 대해 grant 호출 (재활성화 시 역할 재부여).
    password 변경 시 bcrypt 재해싱.
    """
    target = await _get_operator_or_404(db, operator_id)
    update_data = body.model_dump(exclude_unset=True)

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="수정할 항목이 없습니다.",
        )

    # 마지막 admin을 operator로 강등하는 경우 방지
    if (
        "role" in update_data
        and update_data["role"] != "admin"
        and target.role == "admin"
    ):
        active_admin_count = await _count_active_admins(db, exclude_id=target.id)
        if active_admin_count == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="마지막 admin은 강등할 수 없습니다.",
            )

    # 마지막 admin을 비활성화 방지 (본인/타인 모두)
    if (
        "is_active" in update_data
        and update_data["is_active"] is False
        and target.role == "admin"
        and target.is_active
    ):
        active_admin_count = await _count_active_admins(db, exclude_id=target.id)
        if active_admin_count == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="마지막 admin은 비활성화할 수 없습니다.",
            )

    # Discord 연동 변경 추적 (DB 저장 전 기존 값을 먼저 잡아둔다)
    old_discord_id = target.discord_user_id
    new_discord_id: str | None = old_discord_id
    discord_changed = False
    if "discord_user_id" in update_data:
        new_discord_id = update_data["discord_user_id"] or None  # "" → None
        update_data["discord_user_id"] = new_discord_id
        discord_changed = new_discord_id != old_discord_id

    # 비활성화 전환 여부 (is_active=False 이면서 discord_user_id가 존재하는 경우 revoke 필요)
    deactivating = (
        "is_active" in update_data
        and update_data["is_active"] is False
        and target.is_active
    )
    # 활성화 전환 여부 (is_active=True 이면서 기존 비활성 상태였고 discord_user_id 존재하면 grant 필요)
    activating = (
        "is_active" in update_data
        and update_data["is_active"] is True
        and not target.is_active
    )

    # password 재해싱
    if "password" in update_data and update_data["password"] is not None:
        update_data["password_hash"] = hash_password(update_data.pop("password"))
    else:
        update_data.pop("password", None)

    # 필드 반영
    for field_name, value in update_data.items():
        setattr(target, field_name, value)
    target.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.operator.update",
        target_type="operator", target_id=target.id,
        details={
            "changed_fields": list(update_data.keys()),
            "discord_changed": discord_changed,
        },
        ip_address=request.client.host if request.client else None,
    )

    # Discord 봇 호출 순서: 연동 변경 → (기존 revoke → 신규 grant) / 비활성화 → revoke / 활성화 → grant
    if discord_changed:
        if old_discord_id:
            await _safe_revoke_operator_role(old_discord_id)
        if new_discord_id:
            await _safe_grant_operator_role(new_discord_id)
    elif deactivating and target.discord_user_id:
        await _safe_revoke_operator_role(target.discord_user_id)
    elif activating and target.discord_user_id:
        await _safe_grant_operator_role(target.discord_user_id)

    return OperatorResponse.model_validate(target)


@router.delete("/{operator_id}", status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_operator(
    operator_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
):
    """운영자 비활성화 (soft delete, admin 전용).

    가드:
      - 자기 자신 비활성화 금지 (403)
      - 마지막 활성 admin 비활성화 금지 (409)
    discord_user_id가 있으면 Discord 봇에 운영진 역할 회수 요청.
    물리 삭제가 아닌 is_active=False 전환만 수행 (감사 로그 보존 목적).
    """
    if current_operator.id == operator_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="자기 자신을 비활성화할 수 없습니다.",
        )

    target = await _get_operator_or_404(db, operator_id)

    if not target.is_active:
        # 이미 비활성 상태면 멱등하게 204 반환 (추가 처리 불필요)
        return

    if target.role == "admin":
        active_admin_count = await _count_active_admins(db, exclude_id=target.id)
        if active_admin_count == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="마지막 admin은 비활성화할 수 없습니다.",
            )

    target.is_active = False
    target.updated_at = datetime.now(timezone.utc)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.operator.deactivate",
        target_type="operator", target_id=target.id,
        details={
            "username": target.username,
            "role": target.role,
            "had_discord_link": bool(target.discord_user_id),
        },
        ip_address=request.client.host if request.client else None,
    )

    # Discord 봇에 운영진 역할 회수 요청 (실패해도 비활성화는 성공 — 견고성)
    if target.discord_user_id:
        await _safe_revoke_operator_role(target.discord_user_id)


@router.delete("/{operator_id}/purge", status_code=status.HTTP_204_NO_CONTENT)
async def purge_operator(
    operator_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
):
    """운영자 영구 삭제 (hard delete, admin 전용).

    가드 순서:
      1. 대상 존재 확인 (404)
      2. 자기 자신 영구 삭제 금지 (403)
      3. 마지막 활성 admin 영구 삭제 금지 (409)
      4. FK 참조 체크 — 11개 테이블에서 해당 operator.id 참조 개수 합산 (409)
    모든 가드 통과 시 Discord 역할 회수 + DB 물리 삭제 + 감사 로그 기록.
    """
    target = await _get_operator_or_404(db, operator_id)

    if current_operator.id == target.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="자기 자신을 영구 삭제할 수 없습니다.",
        )

    if target.role == "admin":
        active_admin_count = await _count_active_admins(db, exclude_id=target.id)
        if active_admin_count == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="마지막 활성 admin은 영구 삭제할 수 없습니다.",
            )

    # FK 참조 체크 — 11개 참조 지점 COUNT 합산 (cstrike. 스키마 접두사 필수)
    fk_check_sql = text(
        """
        SELECT
          (SELECT COUNT(*) FROM cstrike.competitions WHERE created_by = :id) +
          (SELECT COUNT(*) FROM cstrike.emergency_actions WHERE executed_by = :id OR reverted_by = :id) +
          (SELECT COUNT(*) FROM cstrike.deploy_pipelines WHERE triggered_by = :id) +
          (SELECT COUNT(*) FROM cstrike.ops_audit_logs WHERE actor_id = :id) +
          (SELECT COUNT(*) FROM cstrike.ticket_messages WHERE author_id = :id) +
          (SELECT COUNT(*) FROM cstrike.tickets WHERE assigned_to = :id OR resolved_by = :id) +
          (SELECT COUNT(*) FROM cstrike.vuln_services WHERE approved_by = :id OR registered_by = :id) +
          (SELECT COUNT(*) FROM cstrike.vulnpack_schedules WHERE released_by = :id) +
          (SELECT COUNT(*) FROM cstrike.competition_config WHERE updated_by = :id) AS total
        """
    )
    fk_result = await db.execute(fk_check_sql, {"id": target.id})
    total_refs = int(fk_result.scalar_one() or 0)
    if total_refs > 0:
        # 프론트가 일관된 문자열 에러로 파싱하도록 detail은 문자열로 구성하되
        # 참조 수치를 본문에 포함시켜 사용자가 즉시 판단할 수 있게 한다.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"이 운영자는 다른 기록에서 참조 중이므로 영구 삭제할 수 없습니다."
                f" 비활성화만 가능합니다. (참조 {total_refs}건)"
            ),
        )

    # 감사 로그는 삭제 이전에 기록 (ops_audit_logs.actor_id는 current_operator이므로 영향 없음)
    purged_discord_id = target.discord_user_id
    purged_username = target.username
    purged_role = target.role

    await record_audit(
        db, current_operator, "ops.operator.purge",
        target_type="operator", target_id=target.id,
        details={
            "username": purged_username,
            "role": purged_role,
        },
        ip_address=request.client.host if request.client else None,
    )

    await db.delete(target)
    await db.flush()

    # Discord 봇에 운영진 역할 회수 요청 (실패해도 영구 삭제는 성공 — 견고성)
    if purged_discord_id:
        await _safe_revoke_operator_role(purged_discord_id)
