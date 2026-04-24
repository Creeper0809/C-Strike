"""운영자(Operator) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class Operator(Base):
    """운영 포털 관리자/운영자 계정."""

    __tablename__ = "operators"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    username = Column(String(50), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    display_name = Column(String(100), nullable=False)
    role = Column(String(20), nullable=False, default="operator")  # admin / operator
    is_active = Column(Boolean, default=True)
    last_login_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    # Discord 사용자 ID (snowflake 18~20자리 숫자 문자열). Null 허용 — 미연동 운영자 존재 가능.
    # 값이 설정되면 운영포털이 Discord 봇에 운영진 역할 Push/Revoke를 자동 요청한다.
    discord_user_id = Column(String(32), nullable=True)
