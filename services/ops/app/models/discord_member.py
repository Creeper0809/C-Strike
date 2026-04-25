"""디스코드 길드 멤버 디렉터리 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class DiscordGuildMember(Base):
    """디스코드 서버 멤버 스냅샷.

    운영포털은 이 테이블을 기준으로 운영자 승격/팀원 추가 후보를 보여준다.
    실제 소스는 Discord 봇이며, 주기적 또는 수동 sync로 최신화한다.
    """

    __tablename__ = "discord_guild_members"
    __table_args__ = (
        UniqueConstraint("discord_user_id", name="uq_discord_guild_members_user"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    guild_id = Column(String(32), nullable=False)
    discord_user_id = Column(String(32), nullable=False)
    username = Column(String(100), nullable=False)
    display_name = Column(String(100))
    global_name = Column(String(100))
    nick = Column(String(100))
    is_bot = Column(Boolean, nullable=False, default=False)
    is_in_guild = Column(Boolean, nullable=False, default=True)
    synced_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
