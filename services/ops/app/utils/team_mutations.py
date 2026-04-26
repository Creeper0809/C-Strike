"""팀 관련 변경 작업의 실행 직렬화/상태 기록 유틸."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.team_mutation import TeamMutation
from app.models.operator import Operator


RUNNING = "running"
COMPLETED = "completed"
FAILED = "failed"

TEAM_MUTATION_STALE_SECONDS = 15 * 60


class TeamMutationConflictError(RuntimeError):
    """같은 리소스에 대한 작업이 이미 진행 중일 때."""


def team_resource_key(team_id: UUID) -> str:
    return f"team:{team_id}"


def team_create_resource_key(*, competition_id: UUID, team_name: str) -> str:
    del team_name  # 슬롯 자동 배정 충돌을 피하려고 대회 단위로 직렬화한다.
    return f"competition:{competition_id}:team-create"


def mutation_result_with_warning(
    current: dict | None,
    *,
    warning: str,
) -> dict:
    result = dict(current or {})
    warnings = list(result.get("warnings") or [])
    warnings.append(warning)
    result["warnings"] = warnings
    return result


def mark_mutation_completed(
    mutation: TeamMutation,
    *,
    result: dict | None = None,
) -> None:
    mutation.status = COMPLETED
    mutation.result = result
    mutation.error_detail = None
    mutation.completed_at = datetime.now(timezone.utc)


def mark_mutation_failed(
    mutation: TeamMutation,
    *,
    error_detail: str,
    result: dict | None = None,
) -> None:
    mutation.status = FAILED
    mutation.error_detail = error_detail
    mutation.result = result
    mutation.completed_at = datetime.now(timezone.utc)


async def _get_running_mutation(
    db: AsyncSession,
    *,
    resource_key: str,
) -> TeamMutation | None:
    return (
        await db.execute(
            select(TeamMutation).where(
                TeamMutation.resource_key == resource_key,
                TeamMutation.status == RUNNING,
            )
        )
    ).scalar_one_or_none()


async def _mark_stale_running_mutation_failed(
    db: AsyncSession,
    *,
    mutation: TeamMutation,
) -> None:
    mark_mutation_failed(
        mutation,
        error_detail="stale-running-mutation-cleanup",
        result={
            "stale": True,
            "resource_key": mutation.resource_key,
        },
    )
    await db.commit()


async def start_team_mutation(
    db: AsyncSession,
    *,
    resource_key: str,
    operation_type: str,
    current_operator: Operator,
    competition_id: UUID | None = None,
    team_id: UUID | None = None,
    member_id: UUID | None = None,
    payload: dict | None = None,
) -> TeamMutation:
    """동일 리소스 작업을 직렬화하면서 실행 기록을 남긴다."""
    mutation = TeamMutation(
        resource_key=resource_key,
        operation_type=operation_type,
        competition_id=competition_id,
        team_id=team_id,
        member_id=member_id,
        requested_by_operator_id=current_operator.id,
        requested_by_name=current_operator.display_name,
        payload=payload,
    )
    db.add(mutation)
    try:
        await db.commit()
        await db.refresh(mutation)
        return mutation
    except IntegrityError:
        await db.rollback()
        running = await _get_running_mutation(db, resource_key=resource_key)
        if running is not None and running.started_at is not None:
            age = datetime.now(timezone.utc) - running.started_at
            if age > timedelta(seconds=TEAM_MUTATION_STALE_SECONDS):
                await _mark_stale_running_mutation_failed(db, mutation=running)
                db.add(mutation)
                try:
                    await db.commit()
                    await db.refresh(mutation)
                    return mutation
                except IntegrityError:
                    await db.rollback()
        raise TeamMutationConflictError(
            "동일한 팀 변경 작업이 이미 진행 중입니다. 잠시 후 다시 시도하세요."
        )


async def persist_team_mutation_failed(
    db: AsyncSession,
    *,
    mutation_id: UUID,
    error_detail: str,
    result: dict | None = None,
) -> None:
    mutation = await db.get(TeamMutation, mutation_id)
    if mutation is None:
        return
    mark_mutation_failed(
        mutation,
        error_detail=error_detail,
        result=result,
    )
    await db.commit()


async def append_team_mutation_warning(
    db: AsyncSession,
    *,
    mutation_id: UUID,
    warning: str,
) -> None:
    mutation = await db.get(TeamMutation, mutation_id)
    if mutation is None:
        return
    mutation.result = mutation_result_with_warning(mutation.result, warning=warning)
    await db.commit()
