"""인증 의존성 — JWT 쿠키 기반 운영자 인증 및 역할 검증."""

from typing import Callable

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.operator import Operator
from app.utils.security import decode_access_token


async def get_current_operator(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Operator:
    """JWT 쿠키에서 토큰을 추출하고, DB에서 운영자를 조회한다.

    Raises:
        HTTPException 401: 토큰이 없거나 유효하지 않은 경우.
        HTTPException 401: 운영자가 존재하지 않거나 비활성 상태인 경우.
    """
    token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="인증 토큰이 없습니다.",
        )

    try:
        payload = decode_access_token(token)
        operator_id: str | None = payload.get("sub")
        if operator_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="유효하지 않은 토큰입니다.",
            )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="토큰 검증에 실패했습니다.",
        )

    result = await db.execute(
        select(Operator).where(Operator.id == operator_id)
    )
    operator = result.scalar_one_or_none()

    if operator is None or not operator.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="비활성 계정이거나 존재하지 않는 운영자입니다.",
        )

    return operator


def require_role(*roles: str) -> Callable:
    """지정된 역할만 접근을 허용하는 의존성을 반환한다.

    사용 예:
        @router.get("/admin-only", dependencies=[Depends(require_role("admin"))])
    """
    async def role_checker(
        current_operator: Operator = Depends(get_current_operator),
    ) -> Operator:
        if current_operator.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"권한이 부족합니다. 필요 역할: {', '.join(roles)}",
            )
        return current_operator

    return role_checker
