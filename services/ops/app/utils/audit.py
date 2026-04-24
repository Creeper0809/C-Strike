"""감사 로그 기록 유틸리티."""

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import OpsAuditLog
from app.models.operator import Operator


async def record_audit(
    db: AsyncSession,
    operator: Operator,
    action: str,
    target_type: str | None = None,
    target_id: UUID | None = None,
    details: dict | None = None,
    ip_address: str | None = None,
) -> OpsAuditLog:
    """감사 로그 한 건을 기록하고 반환한다."""
    log = OpsAuditLog(
        actor_id=operator.id,
        actor_name=operator.display_name,
        action=action,
        target_type=target_type,
        target_id=target_id,
        details=details,
        ip_address=ip_address,
    )
    db.add(log)
    await db.flush()
    return log


async def record_bot_audit(
    db: AsyncSession,
    action: str,
    target_type: str | None = None,
    target_id: UUID | None = None,
    details: dict | None = None,
) -> OpsAuditLog:
    """디스코드 봇 행동 감사 로그. operator 없이 기록한다."""
    log = OpsAuditLog(
        actor_id=None,
        actor_name="디스코드 봇",
        action=action,
        target_type=target_type,
        target_id=target_id,
        details=details,
        ip_address=None,
    )
    db.add(log)
    await db.flush()
    return log
