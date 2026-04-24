"""내부 API — deploy-service에서 호출하는 콜백 엔드포인트

X-Internal-API-Key 헤더로 인증. 외부에서 직접 접근 불가.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.team_service import TeamService

router = APIRouter(prefix="/api/v1/internal", tags=["internal"])


def verify_internal_key(request: Request):
    api_key = request.headers.get("X-Internal-API-Key")
    if api_key != settings.INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="유효하지 않은 내부 API 키")


class TeamServiceUpdate(BaseModel):
    host_ip: str
    port: int
    container_id: str
    status: str  # "running" / "stopped" / "error"


@router.put("/team-services/{team_id}/{service_id}", dependencies=[Depends(verify_internal_key)])
async def upsert_team_service(
    team_id: str,
    service_id: str,
    body: TeamServiceUpdate,
    db: AsyncSession = Depends(get_db),
):
    """TeamService 레코드 생성 또는 업데이트."""
    stmt = select(TeamService).where(
        TeamService.team_id == UUID(team_id),
        TeamService.service_id == UUID(service_id),
    )
    result = await db.execute(stmt)
    ts = result.scalar_one_or_none()

    if ts:
        ts.host_ip = body.host_ip
        ts.port = body.port
        ts.container_id = body.container_id
        ts.status = body.status
    else:
        ts = TeamService(
            team_id=UUID(team_id),
            service_id=UUID(service_id),
            host_ip=body.host_ip,
            port=body.port,
            container_id=body.container_id,
            status=body.status,
        )
        db.add(ts)

    await db.commit()
    return {"status": "ok", "team_id": team_id, "service_id": service_id}


@router.delete("/team-services/{team_id}/{service_id}", dependencies=[Depends(verify_internal_key)])
async def delete_team_service(
    team_id: str,
    service_id: str,
    db: AsyncSession = Depends(get_db),
):
    """TeamService 레코드 삭제 (롤백 시)."""
    stmt = select(TeamService).where(
        TeamService.team_id == UUID(team_id),
        TeamService.service_id == UUID(service_id),
    )
    result = await db.execute(stmt)
    ts = result.scalar_one_or_none()

    if ts:
        await db.delete(ts)
        await db.commit()

    return {"status": "ok"}


# ── 취약점팩 자동 공개 (scoring-engine에서 호출) ──

from app.api.vulnpacks import _execute_release, _get_pack_or_404


@router.post("/vulnpacks/{pack_id}/auto-release", dependencies=[Depends(verify_internal_key)])
async def auto_release_vulnpack(
    pack_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """취약점팩을 시스템(scoring-engine)이 자동 공개한다.

    - operator=None → _execute_release 내부에서 admin을 system actor로 사용
    - released_by는 NULL로 기록 (수동 공개와 구분)
    - audit action='system.vulnpack.auto_release'
    - 기존 수동 공개와 동일한 배포 파이프라인 생성 + deploy-service 호출
    - 이미 released 상태면 400 (멱등성)
    """
    pack = await _get_pack_or_404(db, pack_id)

    await _execute_release(
        pack=pack,
        db=db,
        operator=None,
        request_ip=request.client.host if request.client else None,
        trigger="auto",
    )

    return {
        "status": "ok",
        "pack_id": str(pack.id),
        "pack_number": pack.pack_number,
        "released_at": pack.actual_release_at.isoformat() if pack.actual_release_at else None,
    }
