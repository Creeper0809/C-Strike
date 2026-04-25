"""디스코드 길드 멤버 디렉터리 API."""

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_operator
from app.database import get_db
from app.external import discord_client
from app.models.discord_member import DiscordGuildMember
from app.models.operator import Operator
from app.models.team import Team, TeamMember
from app.schemas.discord_directory import (
    DiscordDirectoryMemberItem,
    DiscordDirectoryMemberListResponse,
    DiscordDirectorySyncResponse,
)
from app.utils.audit import record_audit

router = APIRouter(tags=["discord-directory"])


def _preferred_display_name(
    *,
    display_name: str | None = None,
    nick: str | None = None,
    global_name: str | None = None,
    username: str,
    discord_user_id: str | None = None,
) -> str:
    for candidate in (display_name, nick, global_name, username, discord_user_id):
        normalized = str(candidate or "").strip()
        if normalized:
            return normalized
    return "unknown"


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized or normalized.lower() in {"none", "null"}:
        return None
    return normalized


@router.post("/sync", response_model=DiscordDirectorySyncResponse)
async def sync_discord_directory(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> DiscordDirectorySyncResponse:
    """Discord 봇을 통해 길드 멤버 전체 목록을 받아 DB 디렉터리를 갱신한다."""

    payload = await discord_client.list_guild_members()
    guild_id = str(payload.get("guild_id", "")).strip()
    members = payload.get("members") or []
    now = datetime.now(timezone.utc)

    existing_rows = (
        await db.execute(
            select(DiscordGuildMember).where(DiscordGuildMember.guild_id == guild_id)
        )
    ).scalars().all()
    existing_by_user_id = {row.discord_user_id: row for row in existing_rows}

    created = 0
    updated = 0
    seen: set[str] = set()

    for raw in members:
        if not isinstance(raw, dict):
            continue

        discord_user_id = str(raw.get("discord_user_id", "")).strip()
        username = str(raw.get("username", "")).strip()
        if not discord_user_id or not username:
            continue

        display_name = _preferred_display_name(
            display_name=_optional_text(raw.get("display_name")),
            nick=_optional_text(raw.get("nick")),
            global_name=_optional_text(raw.get("global_name")),
            username=username,
            discord_user_id=discord_user_id,
        )
        seen.add(discord_user_id)

        row = existing_by_user_id.get(discord_user_id)
        if row is None:
            row = DiscordGuildMember(
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                username=username,
                display_name=display_name,
                global_name=_optional_text(raw.get("global_name")),
                nick=_optional_text(raw.get("nick")),
                is_bot=bool(raw.get("is_bot", False)),
                is_in_guild=True,
                synced_at=now,
            )
            db.add(row)
            existing_by_user_id[discord_user_id] = row
            created += 1
            continue

        row.username = username
        row.display_name = display_name
        row.global_name = _optional_text(raw.get("global_name"))
        row.nick = _optional_text(raw.get("nick"))
        row.is_bot = bool(raw.get("is_bot", False))
        row.is_in_guild = True
        row.synced_at = now
        updated += 1

    marked_left = 0
    for row in existing_rows:
        if row.discord_user_id in seen:
            continue
        if row.is_in_guild:
            marked_left += 1
        row.is_in_guild = False
        row.synced_at = now

    await db.flush()
    await record_audit(
        db,
        current_operator,
        "ops.discord_directory.sync",
        target_type="discord_directory",
        details={
            "guild_id": guild_id,
            "total_members": len(seen),
            "created": created,
            "updated": updated,
            "marked_left": marked_left,
        },
        ip_address=request.client.host if request.client else None,
    )

    return DiscordDirectorySyncResponse(
        guild_id=guild_id,
        total_members=len(seen),
        created=created,
        updated=updated,
        marked_left=marked_left,
        synced_at=now,
        message="디스코드 서버 멤버 디렉터리를 동기화했습니다.",
    )


@router.get("/members", response_model=DiscordDirectoryMemberListResponse)
async def list_discord_directory_members(
    search: str | None = Query(None, max_length=100),
    competition_id: UUID | None = Query(None),
    team_id: UUID | None = Query(None),
    include_bots: bool = Query(False),
    limit: int = Query(500, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> DiscordDirectoryMemberListResponse:
    """동기화된 디스코드 멤버 디렉터리를 조회한다."""

    query = select(DiscordGuildMember).where(DiscordGuildMember.is_in_guild.is_(True))
    if not include_bots:
        query = query.where(DiscordGuildMember.is_bot.is_(False))

    normalized_search = str(search or "").strip()
    if normalized_search:
        like = f"%{normalized_search}%"
        query = query.where(
            or_(
                DiscordGuildMember.discord_user_id.ilike(like),
                DiscordGuildMember.username.ilike(like),
                DiscordGuildMember.display_name.ilike(like),
                DiscordGuildMember.global_name.ilike(like),
                DiscordGuildMember.nick.ilike(like),
            )
        )

    rows = (await db.execute(query.limit(limit))).scalars().all()
    rows.sort(key=lambda row: _preferred_display_name(
        display_name=row.display_name,
        nick=row.nick,
        global_name=row.global_name,
        username=row.username,
        discord_user_id=row.discord_user_id,
    ).lower())

    user_ids = [row.discord_user_id for row in rows]
    operator_map: dict[str, Operator] = {}
    assignment_map: dict[str, dict[str, Any]] = {}

    if user_ids:
        operators = (
            await db.execute(
                select(Operator).where(Operator.discord_user_id.in_(user_ids))
            )
        ).scalars().all()
        operator_map = {
            op.discord_user_id: op
            for op in operators
            if op.discord_user_id
        }

    if user_ids and competition_id:
        assignment_rows = (
            await db.execute(
                select(TeamMember, Team)
                .join(Team, Team.id == TeamMember.team_id)
                .where(
                    Team.competition_id == competition_id,
                    TeamMember.discord_user_id.in_(user_ids),
                    TeamMember.status.in_(["pending", "approved"]),
                )
            )
        ).all()
        for member, team in assignment_rows:
            assignment_map[member.discord_user_id] = {
                "team_id": team.id,
                "team_name": team.name,
                "team_status": team.status,
                "member_role": member.role,
            }

    items = [
        DiscordDirectoryMemberItem(
            discord_user_id=row.discord_user_id,
            username=row.username,
            display_name=_preferred_display_name(
                display_name=row.display_name,
                nick=row.nick,
                global_name=row.global_name,
                username=row.username,
                discord_user_id=row.discord_user_id,
            ),
            global_name=row.global_name,
            nick=row.nick,
            is_bot=row.is_bot,
            is_in_guild=row.is_in_guild,
            synced_at=row.synced_at,
            is_operator=row.discord_user_id in operator_map,
            operator_id=operator_map[row.discord_user_id].id if row.discord_user_id in operator_map else None,
            operator_role=operator_map[row.discord_user_id].role if row.discord_user_id in operator_map else None,
            assigned_team_id=assignment_map.get(row.discord_user_id, {}).get("team_id"),
            assigned_team_name=assignment_map.get(row.discord_user_id, {}).get("team_name"),
            assigned_team_status=assignment_map.get(row.discord_user_id, {}).get("team_status"),
            assigned_member_role=assignment_map.get(row.discord_user_id, {}).get("member_role"),
            is_current_team_member=assignment_map.get(row.discord_user_id, {}).get("team_id") == team_id if team_id else False,
        )
        for row in rows
    ]

    return DiscordDirectoryMemberListResponse(items=items, total=len(items))
