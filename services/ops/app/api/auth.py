"""인증 API 라우터 — 로그인, 로그아웃, 현재 운영자 조회."""

from datetime import datetime, timezone

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator
from app.models.operator import Operator
from app.utils.security import create_access_token, verify_password

router = APIRouter(tags=["인증"])


# ── 요청/응답 스키마 ──────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class OperatorResponse(BaseModel):
    id: str | UUID
    username: str
    display_name: str
    role: str
    is_active: bool
    last_login_at: datetime | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


# ── 엔드포인트 ────────────────────────────────────────────────

@router.post("/login")
async def login(
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """운영자 로그인. 검증 성공 시 httpOnly 쿠키로 JWT를 발급한다."""
    result = await db.execute(
        select(Operator).where(Operator.username == body.username)
    )
    operator = result.scalar_one_or_none()

    if operator is None or not verify_password(body.password, operator.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="아이디 또는 비밀번호가 올바르지 않습니다.",
        )

    if not operator.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="비활성화된 계정입니다. 관리자에게 문의하세요.",
        )

    # 마지막 로그인 시각 갱신
    await db.execute(
        update(Operator)
        .where(Operator.id == operator.id)
        .values(last_login_at=datetime.now(timezone.utc))
    )

    # JWT 발급
    token = create_access_token(data={"sub": str(operator.id)})
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,  # 개발 환경용; 프로덕션에서는 True
        max_age=480 * 60,
    )

    return {"message": "로그인 성공", "operator": OperatorResponse.model_validate(operator)}


@router.post("/logout")
async def logout(response: Response):
    """로그아웃. access_token 쿠키를 삭제한다."""
    response.delete_cookie(key="access_token")
    return {"message": "로그아웃 완료"}


@router.post("/refresh")
async def refresh_token(
    response: Response,
    current_operator: Operator = Depends(get_current_operator),
):
    """토큰 갱신. 유효한 JWT를 가진 운영자에게 새 토큰을 발급한다."""
    token = create_access_token(data={"sub": str(current_operator.id)})
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,  # 개발 환경용; 프로덕션에서는 True
        max_age=480 * 60,
    )
    return {"message": "토큰 갱신 완료"}


@router.get("/ws-token")
async def get_ws_token(
    current_operator: Operator = Depends(get_current_operator),
):
    """WebSocket 연결용 단기 토큰 발급. httpOnly 쿠키에서 직접 읽을 수 없으므로 별도 제공."""
    token = create_access_token(data={"sub": str(current_operator.id)})
    return {"token": token}


@router.get("/me", response_model=OperatorResponse)
async def get_me(
    current_operator: Operator = Depends(get_current_operator),
):
    """현재 로그인한 운영자 정보를 반환한다."""
    return OperatorResponse.model_validate(current_operator)
