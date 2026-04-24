"""감사 로그 API 라우터 --- 로그 조회 및 내보내기."""

import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator
from app.models.operator import Operator
from app.models.audit import OpsAuditLog
from app.schemas.audit import AuditLogResponse

router = APIRouter(tags=["감사 로그"])


# -- 엔드포인트 -------------------------------------------------------------

@router.get("/")
async def list_audit_logs(
    action: str | None = None,
    action_prefix: str | None = None,
    actor_id: str | None = None,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """감사 로그 목록을 페이지네이션으로 조회한다."""
    base_query = select(OpsAuditLog)
    count_query = select(func.count()).select_from(OpsAuditLog)

    if action:
        base_query = base_query.where(OpsAuditLog.action == action)
        count_query = count_query.where(OpsAuditLog.action == action)
    if action_prefix:
        base_query = base_query.where(OpsAuditLog.action.startswith(action_prefix))
        count_query = count_query.where(OpsAuditLog.action.startswith(action_prefix))
    if actor_id:
        base_query = base_query.where(OpsAuditLog.actor_id == actor_id)
        count_query = count_query.where(OpsAuditLog.actor_id == actor_id)
    if from_date:
        base_query = base_query.where(OpsAuditLog.created_at >= from_date)
        count_query = count_query.where(OpsAuditLog.created_at >= from_date)
    if to_date:
        base_query = base_query.where(OpsAuditLog.created_at <= to_date)
        count_query = count_query.where(OpsAuditLog.created_at <= to_date)

    offset = (page - 1) * limit
    items_result = await db.execute(
        base_query.order_by(OpsAuditLog.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    total_result = await db.execute(count_query)

    items = [
        AuditLogResponse.model_validate(row)
        for row in items_result.scalars().all()
    ]
    total = total_result.scalar() or 0

    return {"items": items, "total": total, "page": page, "limit": limit}


@router.get("/export")
async def export_audit_logs(
    format: str = Query("json", pattern="^(csv|json)$"),
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """감사 로그를 CSV 또는 JSON으로 내보낸다."""
    query = select(OpsAuditLog)

    if from_date:
        query = query.where(OpsAuditLog.created_at >= from_date)
    if to_date:
        query = query.where(OpsAuditLog.created_at <= to_date)

    query = query.order_by(OpsAuditLog.created_at.desc())
    result = await db.execute(query)
    logs = result.scalars().all()

    if format == "json":
        data = [
            AuditLogResponse.model_validate(log).model_dump(mode="json")
            for log in logs
        ]
        return JSONResponse(content=data)

    # CSV 형식
    csv_headers = [
        "id", "actor_name", "action", "target_type",
        "target_id", "ip_address", "created_at",
    ]

    def generate_csv():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(csv_headers)
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        for log in logs:
            writer.writerow([
                str(log.id),
                log.actor_name,
                log.action,
                log.target_type or "",
                str(log.target_id) if log.target_id else "",
                log.ip_address or "",
                str(log.created_at) if log.created_at else "",
            ])
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    return StreamingResponse(
        generate_csv(),
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="audit_log.csv"',
        },
    )
