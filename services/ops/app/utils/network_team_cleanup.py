"""팀 삭제 시 라우터 네트워크 정리 유틸리티."""

from __future__ import annotations

import asyncio
import csv
import io
import ipaddress
import shlex
from dataclasses import dataclass

import paramiko

from app.config import settings


class NetworkTeamCleanupError(RuntimeError):
    """원격 라우터 네트워크 정리 실패."""


@dataclass(frozen=True)
class InventoryTeamRow:
    team_alias: str
    display_name: str
    status: str
    net_id: str
    vpn_prefix: str
    battlefield_cidr: str
    management_cidr: str


@dataclass(frozen=True)
class NetworkTeamCleanupResult:
    team_alias: str
    stdout: str
    stderr: str


def network_team_delete_enabled() -> bool:
    """팀 삭제 시 네트워크 자동화를 사용할지."""
    return bool(
        settings.NETWORK_TEAM_DELETE_ENABLED
        and settings.NETWORK_TEAM_DELETE_HOST.strip()
        and settings.NETWORK_TEAM_DELETE_USER.strip()
        and settings.NETWORK_TEAM_DELETE_PASSWORD
    )


def _parse_inventory_rows(raw_csv: str) -> list[InventoryTeamRow]:
    reader = csv.DictReader(io.StringIO(raw_csv))
    rows: list[InventoryTeamRow] = []
    for row in reader:
        rows.append(
            InventoryTeamRow(
                team_alias=(row.get("team_alias") or "").strip(),
                display_name=(row.get("display_name") or "").strip(),
                status=(row.get("status") or "").strip(),
                net_id=(row.get("net_id") or "").strip(),
                vpn_prefix=(row.get("vpn_prefix") or "").strip(),
                battlefield_cidr=(row.get("battlefield_cidr") or "").strip(),
                management_cidr=(row.get("management_cidr") or "").strip(),
            )
        )
    return rows


def _ip_in_cidr(ip: str | None, cidr: str) -> bool:
    if not ip or not cidr:
        return False
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def _resolve_team_alias(
    rows: list[InventoryTeamRow],
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
) -> str | None:
    active_rows = [row for row in rows if row.status == "active"]

    if subnet:
        for row in active_rows:
            if row.vpn_prefix == subnet:
                return row.team_alias

    if gateway_ip:
        for row in active_rows:
            if _ip_in_cidr(gateway_ip, row.management_cidr):
                return row.team_alias
        for row in active_rows:
            if _ip_in_cidr(gateway_ip, row.battlefield_cidr):
                return row.team_alias

    normalized_name = team_name.strip().lower()
    if normalized_name:
        for row in active_rows:
            if row.display_name.strip().lower() == normalized_name:
                return row.team_alias

    return None


def _connect_router() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=settings.NETWORK_TEAM_DELETE_HOST,
        port=settings.NETWORK_TEAM_DELETE_PORT,
        username=settings.NETWORK_TEAM_DELETE_USER,
        password=settings.NETWORK_TEAM_DELETE_PASSWORD,
        look_for_keys=False,
        allow_agent=False,
        timeout=settings.NETWORK_TEAM_DELETE_TIMEOUT_SECONDS,
        auth_timeout=settings.NETWORK_TEAM_DELETE_TIMEOUT_SECONDS,
        banner_timeout=settings.NETWORK_TEAM_DELETE_TIMEOUT_SECONDS,
    )
    return client


def _read_remote_inventory(ssh: paramiko.SSHClient) -> list[InventoryTeamRow]:
    root = settings.NETWORK_TEAM_DELETE_ROOT.rstrip("/")
    inventory_path = f"{root}/inventory/teams.csv"
    if settings.NETWORK_TEAM_DELETE_USE_SUDO:
        command = f"sudo -S -p '' cat {shlex.quote(inventory_path)}"
    else:
        command = f"cat {shlex.quote(inventory_path)}"

    stdin, stdout, stderr = ssh.exec_command(
        command,
        timeout=settings.NETWORK_TEAM_DELETE_TIMEOUT_SECONDS,
    )
    if settings.NETWORK_TEAM_DELETE_USE_SUDO:
        stdin.write(settings.NETWORK_TEAM_DELETE_PASSWORD + "\n")
        stdin.flush()

    data = stdout.read().decode()
    error = stderr.read().decode().strip()
    exit_code = stdout.channel.recv_exit_status()
    if exit_code != 0:
        raise NetworkTeamCleanupError(
            f"라우터 inventory 조회 실패: {error or inventory_path}"
        )
    return _parse_inventory_rows(data)


def _run_remote_cleanup(ssh: paramiko.SSHClient, team_alias: str) -> NetworkTeamCleanupResult:
    root = settings.NETWORK_TEAM_DELETE_ROOT.rstrip("/")
    delete_script = f"{root}/scripts/delete-team.sh"
    apply_firewall_script = f"{root}/scripts/apply-firewall.sh"

    delete_args = [
        shlex.quote(delete_script),
        "--root",
        shlex.quote(root),
        "--alias",
        shlex.quote(team_alias),
        "--apply",
    ]
    if settings.NETWORK_TEAM_DELETE_EXECUTE_USERS:
        delete_args.append("--execute-users")
    if settings.NETWORK_TEAM_DELETE_PURGE_USERS:
        delete_args.append("--purge-users")
    if settings.NETWORK_TEAM_DELETE_RELEASE_IP:
        delete_args.append("--release-ip")

    remote_script = "\n".join(
        [
            "set -euo pipefail",
            " ".join(delete_args),
            f"{shlex.quote(apply_firewall_script)} --root {shlex.quote(root)} --execute",
            "systemctl reload openvpn-server@server || systemctl restart openvpn-server@server",
        ]
    )

    if settings.NETWORK_TEAM_DELETE_USE_SUDO:
        command = f"sudo -S -p '' /bin/bash -lc {shlex.quote(remote_script)}"
    else:
        command = f"/bin/bash -lc {shlex.quote(remote_script)}"

    stdin, stdout, stderr = ssh.exec_command(
        command,
        timeout=settings.NETWORK_TEAM_DELETE_TIMEOUT_SECONDS,
    )
    if settings.NETWORK_TEAM_DELETE_USE_SUDO:
        stdin.write(settings.NETWORK_TEAM_DELETE_PASSWORD + "\n")
        stdin.flush()

    out = stdout.read().decode()
    err = stderr.read().decode().strip()
    exit_code = stdout.channel.recv_exit_status()
    if exit_code != 0:
        raise NetworkTeamCleanupError(
            f"라우터 팀 정리 실패(alias={team_alias}): {err or out or f'exit={exit_code}'}"
        )

    return NetworkTeamCleanupResult(team_alias=team_alias, stdout=out, stderr=err)


def _cleanup_team_network_blocking(
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
    allow_missing: bool,
) -> NetworkTeamCleanupResult | None:
    if not network_team_delete_enabled():
        return None

    if not (subnet or gateway_ip or team_name.strip()):
        return None

    ssh = _connect_router()
    try:
        rows = _read_remote_inventory(ssh)
        team_alias = _resolve_team_alias(
            rows,
            team_name=team_name,
            subnet=subnet,
            gateway_ip=gateway_ip,
        )
        if not team_alias:
            if allow_missing:
                return None
            raise NetworkTeamCleanupError(
                "네트워크 inventory에서 팀 슬롯(alias)을 찾지 못했습니다. "
                "subnet/gateway_ip 매핑을 확인하세요."
            )
        return _run_remote_cleanup(ssh, team_alias)
    finally:
        ssh.close()


async def cleanup_team_network(
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
    allow_missing: bool = False,
) -> NetworkTeamCleanupResult | None:
    """운영 포털 팀 삭제와 함께 라우터 VPN/iptables를 정리한다."""
    return await asyncio.to_thread(
        _cleanup_team_network_blocking,
        team_name=team_name,
        subnet=subnet,
        gateway_ip=gateway_ip,
        allow_missing=allow_missing,
    )
