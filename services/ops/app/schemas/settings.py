"""대회 설정(Settings) 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ConfigItemResponse(BaseModel):
    key: str
    value: dict | str | int | float | bool
    updated_by: UUID | None = None
    updated_at: datetime | None = None
    model_config = {"from_attributes": True}


class ConfigUpdateRequest(BaseModel):
    updates: dict[str, dict | str | int | float | bool]
    # 예: {"competition.name": "C-STRIKE 2026", "scoring.round_interval_seconds": 120}


# ── 디스코드 봇 설정 스키마 ──────────────────────────────────

class DiscordBotConfigResponse(BaseModel):
    """디스코드 봇 설정 조회 응답 — 토큰/키는 마스킹."""

    discord_bot_token: str = ""
    discord_guild_id: str = ""
    discord_announcement_channel_id: str = ""
    discord_emergency_channel_id: str = ""
    discord_ticket_channel_id: str = ""
    discord_admin_role_id: str = ""
    bot_api_base_url: str = ""
    bot_api_key: str = ""


class DiscordBotConfigUpdateRequest(BaseModel):
    """디스코드 봇 설정 변경 요청."""

    discord_bot_token: str | None = Field(default=None, description="봇 토큰")
    discord_guild_id: str | None = Field(default=None, description="서버(길드) ID")
    discord_announcement_channel_id: str | None = Field(default=None, description="공지 채널 ID")
    discord_emergency_channel_id: str | None = Field(default=None, description="비상 채널 ID")
    discord_ticket_channel_id: str | None = Field(default=None, description="티켓 채널 ID")
    discord_admin_role_id: str | None = Field(default=None, description="관리자 역할 ID")
    bot_api_base_url: str | None = Field(default=None, description="봇 API 기본 URL")
    bot_api_key: str | None = Field(default=None, description="봇 API 키")
