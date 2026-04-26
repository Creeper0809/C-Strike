"""운영 포털 팀 슬롯 풀 유틸리티."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import shlex
from dataclasses import dataclass
import string

import paramiko
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.team import Team


class TeamSlotPoolError(RuntimeError):
    """팀 슬롯 풀 조회 또는 파싱 실패."""


@dataclass(frozen=True)
class TeamSlot:
    """사전 준비된 팀 슬롯 1개."""

    slot_id: str
    subnet: str
    gateway_ip: str
    physical_host_ip: str | None = None
    battlefield_ip: str | None = None
    team_alias: str | None = None
    net_id: int | None = None
    vpn_user_count: int = 0
    ssh_port: int = 22
    ssh_user: str | None = None
    ssh_password: str | None = None
    vpn_profile_issued: bool = True


def _effective_inventory_host() -> str:
    return (
        settings.NETWORK_TEAM_PROVISION_HOST.strip()
        or settings.NETWORK_TEAM_DELETE_HOST.strip()
    )


def _effective_inventory_user() -> str:
    return (
        settings.NETWORK_TEAM_PROVISION_USER.strip()
        or settings.NETWORK_TEAM_DELETE_USER.strip()
    )


def _effective_inventory_password() -> str:
    return (
        settings.NETWORK_TEAM_PROVISION_PASSWORD
        or settings.NETWORK_TEAM_DELETE_PASSWORD
    )


def _effective_inventory_port() -> int:
    return (
        settings.NETWORK_TEAM_PROVISION_PORT
        or settings.NETWORK_TEAM_DELETE_PORT
    )


def _effective_inventory_root() -> str:
    root = (
        settings.NETWORK_TEAM_PROVISION_ROOT.strip()
        or settings.NETWORK_TEAM_DELETE_ROOT.strip()
    )
    return root.rstrip("/")


def _effective_inventory_timeout() -> int:
    return (
        settings.NETWORK_TEAM_PROVISION_TIMEOUT_SECONDS
        or settings.NETWORK_TEAM_DELETE_TIMEOUT_SECONDS
    )


def _effective_inventory_use_sudo() -> bool:
    return (
        settings.NETWORK_TEAM_PROVISION_USE_SUDO
        or settings.NETWORK_TEAM_DELETE_USE_SUDO
    )


def _has_remote_inventory_access() -> bool:
    return bool(
        _effective_inventory_host()
        and _effective_inventory_user()
        and _effective_inventory_password()
        and _effective_inventory_root()
    )


def _parse_bool(value: object, *, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if not normalized:
        return default
    return normalized in {"1", "true", "yes", "y", "on"}


def _derive_slot_number(item: dict[str, object], *, index: int) -> int:
    raw_slot_number = item.get("slot_number")
    if raw_slot_number is None:
        raw_slot_number = item.get("net_id")

    if raw_slot_number is None or not str(raw_slot_number).strip():
        slot_number = index
    else:
        try:
            slot_number = int(str(raw_slot_number).strip())
        except ValueError as exc:  # pragma: no cover - defensive
            raise TeamSlotPoolError(
                f"slot_number/net_id 값이 올바르지 않습니다: {raw_slot_number}"
            ) from exc

    if slot_number < 1 or slot_number > 254:
        raise TeamSlotPoolError(f"허용되지 않는 slot_number입니다: {slot_number}")
    return slot_number


def _default_slot_id(slot_number: int) -> str:
    if slot_number <= len(string.ascii_lowercase):
        return f"team-slot-{string.ascii_lowercase[slot_number - 1]}"
    return f"team-slot-{slot_number}"


def _derive_battlefield_ip(slot_number: int) -> str:
    return f"10.1.{slot_number}.10"


def _derive_gateway_ip(slot_number: int) -> str:
    return f"10.2.{slot_number}.10"


def _derive_subnet(slot_number: int) -> str:
    return f"10.88.{slot_number}.0/24"


def _build_team_slot(item: dict[str, object], *, source: str, index: int) -> TeamSlot:
    slot_number = _derive_slot_number(item, index=index)
    physical_host_ip = str(item.get("physical_host_ip", "")).strip() or None

    subnet = str(item.get("subnet", "")).strip() or _derive_subnet(slot_number)
    gateway_ip = (
        str(item.get("gateway_ip", "")).strip() or _derive_gateway_ip(slot_number)
    )
    if not subnet or not gateway_ip:
        raise TeamSlotPoolError(
            f"{source} item #{index} requires subnet and gateway_ip."
        )

    slot_id = str(item.get("slot_id") or _default_slot_id(slot_number)).strip()
    battlefield_ip = (
        str(item.get("battlefield_ip", "")).strip()
        or _derive_battlefield_ip(slot_number)
    )
    team_alias = str(item.get("team_alias", "")).strip() or None
    raw_net_id = item.get("net_id")
    net_id = (
        int(raw_net_id)
        if raw_net_id is not None and str(raw_net_id).strip()
        else slot_number
    )
    vpn_user_count = int(item.get("vpn_user_count", 0))
    ssh_port = int(item.get("ssh_port") or settings.TEAM_SLOT_DEFAULT_SSH_PORT or 22)
    ssh_user = item.get("ssh_user") or settings.TEAM_SLOT_DEFAULT_SSH_USER
    ssh_password = item.get("ssh_password") or settings.TEAM_SLOT_DEFAULT_SSH_PASSWORD
    vpn_profile_issued = _parse_bool(item.get("vpn_profile_issued", True), default=True)

    return TeamSlot(
        slot_id=slot_id,
        subnet=subnet,
        gateway_ip=gateway_ip,
        physical_host_ip=physical_host_ip,
        battlefield_ip=battlefield_ip,
        team_alias=team_alias,
        net_id=net_id,
        vpn_user_count=vpn_user_count,
        ssh_port=ssh_port,
        ssh_user=str(ssh_user).strip() if ssh_user is not None else None,
        ssh_password=str(ssh_password) if ssh_password is not None else None,
        vpn_profile_issued=vpn_profile_issued,
    )


def _parse_json_slot_pool() -> list[TeamSlot]:
    raw = settings.TEAM_SLOT_POOL_JSON.strip()
    if not raw:
        return []

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise TeamSlotPoolError("TEAM_SLOT_POOL_JSON is not valid JSON.") from exc

    if not isinstance(data, list):
        raise TeamSlotPoolError("TEAM_SLOT_POOL_JSON must be a JSON array.")

    slots: list[TeamSlot] = []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            raise TeamSlotPoolError(
                f"TEAM_SLOT_POOL_JSON item #{index} must be an object."
            )
        slots.append(_build_team_slot(item, source="TEAM_SLOT_POOL_JSON", index=index))
    return slots


def _connect_inventory_host() -> paramiko.SSHClient:
    timeout = _effective_inventory_timeout()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=_effective_inventory_host(),
        port=_effective_inventory_port(),
        username=_effective_inventory_user(),
        password=_effective_inventory_password(),
        look_for_keys=False,
        allow_agent=False,
        timeout=timeout,
        auth_timeout=timeout,
        banner_timeout=timeout,
    )
    return client


def _read_remote_inventory_csv() -> str | None:
    if not _has_remote_inventory_access():
        return None

    root = _effective_inventory_root()
    filename = settings.TEAM_SLOT_INVENTORY_FILENAME.strip() or "team-slots.csv"
    inventory_path = f"{root}/inventory/{filename}"
    use_sudo = _effective_inventory_use_sudo()
    timeout = _effective_inventory_timeout()

    ssh = _connect_inventory_host()
    try:
        if use_sudo:
            command = f"sudo -S -p '' cat {shlex.quote(inventory_path)}"
        else:
            command = f"cat {shlex.quote(inventory_path)}"

        stdin, stdout, stderr = ssh.exec_command(command, timeout=timeout)
        if use_sudo:
            stdin.write(_effective_inventory_password() + "\n")
            stdin.flush()

        data = stdout.read().decode()
        error = stderr.read().decode().strip()
        exit_code = stdout.channel.recv_exit_status()
        if exit_code != 0:
            if settings.TEAM_SLOT_POOL_JSON.strip():
                return None
            if "No such file" in error or "not found" in error:
                return None
            raise TeamSlotPoolError(
                f"라우터 슬롯 inventory 조회 실패: {error or inventory_path}"
            )
        return data
    finally:
        ssh.close()


def _parse_csv_slot_pool(raw_csv: str) -> list[TeamSlot]:
    reader = csv.DictReader(io.StringIO(raw_csv))
    slots: list[TeamSlot] = []
    for index, row in enumerate(reader, start=1):
        if not row:
            continue
        normalized = {
            key: (value.strip() if isinstance(value, str) else value)
            for key, value in row.items()
            if key is not None
        }
        if not any(str(value or "").strip() for value in normalized.values()):
            continue
        slots.append(
            _build_team_slot(
                normalized,
                source=settings.TEAM_SLOT_INVENTORY_FILENAME or "team-slots.csv",
                index=index,
            )
        )
    return slots


def _load_team_slot_pool_blocking() -> list[TeamSlot]:
    raw_remote_csv = _read_remote_inventory_csv()
    if raw_remote_csv is not None:
        return _parse_csv_slot_pool(raw_remote_csv)
    return _parse_json_slot_pool()


async def get_team_slot_pool() -> list[TeamSlot]:
    """라우터 inventory 또는 legacy 환경변수에서 팀 슬롯 풀을 읽어온다."""
    return await asyncio.to_thread(_load_team_slot_pool_blocking)


async def allocate_team_slot(
    db: AsyncSession,
    *,
    slot_pool: list[TeamSlot] | None = None,
) -> TeamSlot | None:
    """현재 DB에서 사용 중이 아닌 첫 번째 슬롯을 반환한다."""
    pool = slot_pool if slot_pool is not None else await get_team_slot_pool()
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
