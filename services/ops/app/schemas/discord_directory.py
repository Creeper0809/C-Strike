"""디스코드 길드 멤버 디렉터리 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class DiscordDirectoryMemberItem(BaseModel):
    """운영포털에서 사용하는 디스코드 멤버 디렉터리 행."""

    discord_user_id: str
    username: str
    display_name: str
    global_name: str | None = None
    nick: str | None = None
    is_bot: bool
    is_in_guild: bool
    synced_at: datetime
    is_operator: bool = False
    operator_id: UUID | None = None
    operator_role: str | None = None
    assigned_team_id: UUID | None = None
    assigned_team_name: str | None = None
    assigned_team_status: str | None = None
    assigned_member_role: str | None = None
    is_current_team_member: bool = False


class DiscordDirectoryMemberListResponse(BaseModel):
    """디스코드 멤버 디렉터리 목록 응답."""

    items: list[DiscordDirectoryMemberItem]
    total: int


class DiscordDirectorySyncResponse(BaseModel):
    """디스코드 멤버 디렉터리 동기화 결과."""

    guild_id: str
    total_members: int
    created: int
    updated: int
    marked_left: int
    synced_at: datetime
    message: str
