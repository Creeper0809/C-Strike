"""운영 포털 팀 슬롯 풀 유틸리티."""

from __future__ import annotations

import json
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.team import Team


@dataclass(frozen=True)
class TeamSlot:
    """사전 준비된 팀 슬롯 1개."""

    slot_id: str
    subnet: str
    gateway_ip: str
    ssh_port: int = 22
    ssh_user: str | None = None
    ssh_password: str | None = None
    vpn_profile_issued: bool = True


def get_team_slot_pool() -> list[TeamSlot]:
    """환경변수에서 팀 슬롯 풀을 읽어온다."""
    raw = settings.TEAM_SLOT_POOL_JSON.strip()
    if not raw:
        return []

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("TEAM_SLOT_POOL_JSON is not valid JSON.") from exc

    if not isinstance(data, list):
        raise ValueError("TEAM_SLOT_POOL_JSON must be a JSON array.")

    slots: list[TeamSlot] = []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"TEAM_SLOT_POOL_JSON item #{index} must be an object.")

        subnet = str(item.get("subnet", "")).strip()
        gateway_ip = str(item.get("gateway_ip", "")).strip()
        if not subnet or not gateway_ip:
            raise ValueError(
                f"TEAM_SLOT_POOL_JSON item #{index} requires subnet and gateway_ip."
            )

        slot_id = str(item.get("slot_id") or f"slot-{index}").strip()
        ssh_port = int(item.get("ssh_port", 22))
        ssh_user = item.get("ssh_user")
        ssh_password = item.get("ssh_password")
        vpn_profile_issued = bool(item.get("vpn_profile_issued", True))

        slots.append(
            TeamSlot(
                slot_id=slot_id,
                subnet=subnet,
                gateway_ip=gateway_ip,
                ssh_port=ssh_port,
                ssh_user=str(ssh_user).strip() if ssh_user is not None else None,
                ssh_password=str(ssh_password) if ssh_password is not None else None,
                vpn_profile_issued=vpn_profile_issued,
            )
        )

    return slots


async def allocate_team_slot(db: AsyncSession) -> TeamSlot | None:
    """현재 DB에서 사용 중이 아닌 첫 번째 슬롯을 반환한다."""
    pool = get_team_slot_pool()
    if not pool:
        return None

    used_subnets = set(
        (
            await db.execute(
                select(Team.subnet).where(Team.subnet.is_not(None))
            )
        )
        .scalars()
        .all()
    )
    used_gateways = set(
        (
            await db.execute(
                select(Team.gateway_ip).where(Team.gateway_ip.is_not(None))
            )
        )
        .scalars()
        .all()
    )

    for slot in pool:
        if slot.subnet in used_subnets:
            continue
        if slot.gateway_ip in used_gateways:
            continue
        return slot
    return None
