"""보안 유틸리티 — 비밀번호 해싱 및 JWT 토큰 관리."""

from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from app.config import settings


def hash_password(password: str) -> str:
    """평문 비밀번호를 bcrypt로 해싱한다."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    """평문 비밀번호와 해시를 비교 검증한다."""
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_access_token(data: dict) -> str:
    """JWT 액세스 토큰을 생성한다.

    Args:
        data: 토큰 페이로드에 포함할 데이터 (sub 필드 권장).

    Returns:
        인코딩된 JWT 문자열.
    """
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(
        to_encode,
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )


def decode_access_token(token: str) -> dict:
    """JWT 토큰을 디코딩한다.

    Args:
        token: 인코딩된 JWT 문자열.

    Returns:
        디코딩된 페이로드 dict.

    Raises:
        JWTError: 토큰이 유효하지 않거나 만료된 경우.
    """
    return jwt.decode(
        token,
        settings.JWT_SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
    )
