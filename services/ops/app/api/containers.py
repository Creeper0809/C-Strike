"""컨테이너 관리 API — deploy-service 프록시."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from app.config import settings
from app.database import get_db
from app.api.deps import get_current_operator
from app.models.operator import Operator
from app.utils.audit import record_audit

router = APIRouter(tags=["컨테이너"])


# ── Pydantic 모델 ─────────────────────────────────────────────

class ContainerActionRequest(BaseModel):
    reason: str = ""


# ── 내부 헬퍼 ─────────────────────────────────────────────────

async def _deploy_request(method: str, path: str, **kwargs) -> dict:
    """deploy-service에 프록시 요청."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await getattr(client, method)(
            f"{settings.DEPLOY_SERVICE_URL}{path}",
            headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
            **kwargs,
        )
    if resp.status_code >= 400:
        detail = resp.text
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            pass
        raise HTTPException(resp.status_code, detail)
    return resp.json()


# ── GET 엔드포인트 (프록시) ───────────────────────────────────

@router.get("/")
async def list_containers(
    current_operator: Operator = Depends(get_current_operator),
):
    """전체 서비스 컨테이너 조회."""
    return await _deploy_request("get", "/containers")


@router.get("/{team_id}")
async def get_team_containers(
    team_id: str,
    current_operator: Operator = Depends(get_current_operator),
):
    """특정 팀 컨테이너."""
    return await _deploy_request("get", f"/containers/{team_id}")


@router.get("/{container_id}/logs")
async def get_container_logs(
    container_id: str,
    current_operator: Operator = Depends(get_current_operator),
):
    """컨테이너 로그."""
    return await _deploy_request("get", f"/containers/{container_id}/logs")


# ── POST 엔드포인트 (인증 + 감사 로그) ──────────────────────

@router.post("/{team_id}/reset")
async def reset_container(
    team_id: str,
    body: ContainerActionRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """컨테이너 리셋."""
    result = await _deploy_request("post", f"/containers/reset/{team_id}/{team_id}")
    await record_audit(
        db, current_operator, "ops.container.reset",
        details={"team_id": team_id, "reason": body.reason},
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()
    return result


@router.post("/{team_id}/stop")
async def stop_container(
    team_id: str,
    body: ContainerActionRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """컨테이너 중단."""
    result = await _deploy_request("post", f"/containers/{team_id}/stop")
    await record_audit(
        db, current_operator, "ops.container.stop",
        details={"team_id": team_id, "reason": body.reason},
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()
    return result
