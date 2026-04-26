"""팀 생성 시 라우터 네트워크 프로비저닝 유틸리티."""

from __future__ import annotations

import asyncio
import re
import shlex
import zlib
from dataclasses import dataclass

import paramiko

from app.config import settings
from app.utils.team_slots import TeamSlot


class NetworkTeamProvisionError(RuntimeError):
    """원격 라우터 팀 생성 실패."""


@dataclass(frozen=True)
class NetworkTeamProvisionPlan:
    team_alias: str
    net_id: int
    user_count: int


@dataclass(frozen=True)
class NetworkTeamProvisionResult:
    team_alias: str
    net_id: int
    user_count: int
    usernames: tuple[str, ...]
    stdout: str
    stderr: str


def _effective_host() -> str:
    return settings.NETWORK_TEAM_PROVISION_HOST.strip() or settings.NETWORK_TEAM_DELETE_HOST.strip()


def _effective_user() -> str:
    return settings.NETWORK_TEAM_PROVISION_USER.strip() or settings.NETWORK_TEAM_DELETE_USER.strip()


def _effective_password() -> str:
    return settings.NETWORK_TEAM_PROVISION_PASSWORD or settings.NETWORK_TEAM_DELETE_PASSWORD


def _effective_port() -> int:
    return settings.NETWORK_TEAM_PROVISION_PORT or settings.NETWORK_TEAM_DELETE_PORT


def _effective_root() -> str:
    return settings.NETWORK_TEAM_PROVISION_ROOT.rstrip("/") or settings.NETWORK_TEAM_DELETE_ROOT.rstrip("/")


def _effective_timeout() -> int:
    return settings.NETWORK_TEAM_PROVISION_TIMEOUT_SECONDS or settings.NETWORK_TEAM_DELETE_TIMEOUT_SECONDS


def _effective_use_sudo() -> bool:
    return settings.NETWORK_TEAM_PROVISION_USE_SUDO


def network_team_provision_enabled() -> bool:
    """팀 생성 시 라우터 프로비저닝을 사용할지."""
    return bool(
        settings.NETWORK_TEAM_PROVISION_ENABLED
        and _effective_host()
        and _effective_user()
        and _effective_password()
    )


def _slugify_team_alias(team_name: str) -> str:
    value = team_name.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    value = re.sub(r"-{2,}", "-", value)
    if not value:
        raise NetworkTeamProvisionError("팀 이름으로부터 유효한 alias를 만들 수 없습니다.")
    if len(value) > 11:
        suffix = f"{zlib.crc32(value.encode()) & 0xFF:02x}"
        prefix = value[:8].rstrip("-") or value[:8]
        value = f"{prefix}-{suffix}".strip("-")
    return value


def _derive_net_id(subnet: str) -> int:
    match = re.fullmatch(r"\d+\.\d+\.(\d+)\.0/24", subnet.strip())
    if not match:
        raise NetworkTeamProvisionError(
            f"VPN 대역에서 net_id를 해석할 수 없습니다: {subnet}"
        )
    net_id = int(match.group(1))
    if net_id < 1 or net_id > 254:
        raise NetworkTeamProvisionError(f"허용되지 않는 net_id입니다: {net_id}")
    return net_id


def build_team_provision_plan(
    *,
    team_name: str,
    subnet: str,
    slot: TeamSlot | None,
) -> NetworkTeamProvisionPlan:
    """팀 이름/슬롯 정보로 라우터 프로비저닝 계획을 계산한다."""
    team_alias = (slot.team_alias.strip() if slot and slot.team_alias else "") or _slugify_team_alias(team_name)
    net_id = slot.net_id if slot and slot.net_id is not None else _derive_net_id(subnet)
    user_count = (
        slot.vpn_user_count
        if slot and slot.vpn_user_count >= 0
        else settings.NETWORK_TEAM_PROVISION_USERS_PER_TEAM
    )
    if user_count < 0:
        raise NetworkTeamProvisionError("VPN 사용자 수는 0명 이상이어야 합니다.")
    return NetworkTeamProvisionPlan(
        team_alias=team_alias,
        net_id=net_id,
        user_count=user_count,
    )


def _connect_router() -> paramiko.SSHClient:
    timeout = _effective_timeout()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=_effective_host(),
        port=_effective_port(),
        username=_effective_user(),
        password=_effective_password(),
        look_for_keys=False,
        allow_agent=False,
        timeout=timeout,
        auth_timeout=timeout,
        banner_timeout=timeout,
    )
    return client


def _run_remote_provision(
    ssh: paramiko.SSHClient,
    *,
    team_name: str,
    plan: NetworkTeamProvisionPlan,
) -> NetworkTeamProvisionResult:
    root = _effective_root()
    timeout = _effective_timeout()
    add_script = f"{root}/scripts/add-team.sh"
    apply_firewall_script = f"{root}/scripts/apply-firewall.sh"

    add_args = [
        shlex.quote(add_script),
        "--root",
        shlex.quote(root),
        "--alias",
        shlex.quote(plan.team_alias),
        "--display-name",
        shlex.quote(team_name),
        "--net-id",
        str(plan.net_id),
        "--users",
        str(plan.user_count),
        "--apply",
    ]
    if settings.NETWORK_TEAM_PROVISION_REUSE_RETIRED:
        add_args.append("--reuse-retired")
    if settings.NETWORK_TEAM_PROVISION_EXECUTE_USERS:
        add_args.append("--execute-users")

    remote_script = "\n".join(
        [
            "set -euo pipefail",
            " ".join(add_args),
            f"{shlex.quote(apply_firewall_script)} --root {shlex.quote(root)} --execute",
            "systemctl reload openvpn-server@server || systemctl restart openvpn-server@server",
        ]
    )

    if _effective_use_sudo():
        command = f"sudo -S -p '' /bin/bash -lc {shlex.quote(remote_script)}"
    else:
        command = f"/bin/bash -lc {shlex.quote(remote_script)}"

    stdin, stdout, stderr = ssh.exec_command(command, timeout=timeout)
    if _effective_use_sudo():
        stdin.write(_effective_password() + "\n")
        stdin.flush()

    out = stdout.read().decode()
    err = stderr.read().decode().strip()
    exit_code = stdout.channel.recv_exit_status()
    if exit_code != 0:
        cleanup_error = ""
        try:
            _run_remote_cleanup_after_failure(ssh, team_alias=plan.team_alias)
        except Exception as cleanup_exc:  # pragma: no cover - best effort
            cleanup_error = f" / cleanup_failed={cleanup_exc}"
        raise NetworkTeamProvisionError(
            f"라우터 팀 생성 실패(alias={plan.team_alias}, net_id={plan.net_id}): "
            f"{err or out or f'exit={exit_code}'}{cleanup_error}"
        )

    usernames = tuple(
        f"team-{plan.team_alias}-user{index:02d}"
        for index in range(1, plan.user_count + 1)
    )
    return NetworkTeamProvisionResult(
        team_alias=plan.team_alias,
        net_id=plan.net_id,
        user_count=plan.user_count,
        usernames=usernames,
        stdout=out,
        stderr=err,
    )


def _run_remote_cleanup_after_failure(ssh: paramiko.SSHClient, *, team_alias: str) -> None:
    root = _effective_root()
    timeout = _effective_timeout()
    delete_script = f"{root}/scripts/delete-team.sh"
    apply_firewall_script = f"{root}/scripts/apply-firewall.sh"

    delete_args = [
        shlex.quote(delete_script),
        "--root",
        shlex.quote(root),
        "--alias",
        shlex.quote(team_alias),
        "--release-ip",
        "--apply",
    ]
    if settings.NETWORK_TEAM_PROVISION_EXECUTE_USERS:
        delete_args.append("--execute-users")

    remote_script = "\n".join(
        [
            "set -euo pipefail",
            " ".join(delete_args),
            f"{shlex.quote(apply_firewall_script)} --root {shlex.quote(root)} --execute",
            "systemctl reload openvpn-server@server || systemctl restart openvpn-server@server",
        ]
    )
    if _effective_use_sudo():
        command = f"sudo -S -p '' /bin/bash -lc {shlex.quote(remote_script)}"
    else:
        command = f"/bin/bash -lc {shlex.quote(remote_script)}"

    stdin, stdout, stderr = ssh.exec_command(command, timeout=timeout)
    if _effective_use_sudo():
        stdin.write(_effective_password() + "\n")
        stdin.flush()

    stdout.read().decode()
    cleanup_err = stderr.read().decode().strip()
    exit_code = stdout.channel.recv_exit_status()
    if exit_code != 0:
        raise NetworkTeamProvisionError(
            f"생성 실패 후 라우터 보상 정리 실패(alias={team_alias}): "
            f"{cleanup_err or f'exit={exit_code}'}"
        )


def _provision_team_network_blocking(
    *,
    team_name: str,
    subnet: str,
    slot: TeamSlot | None,
) -> NetworkTeamProvisionResult:
    if not network_team_provision_enabled():
        raise NetworkTeamProvisionError("팀 생성 라우터 프로비저닝이 비활성화되어 있습니다.")

    plan = build_team_provision_plan(
        team_name=team_name,
        subnet=subnet,
        slot=slot,
    )
    ssh = _connect_router()
    try:
        return _run_remote_provision(
            ssh,
            team_name=team_name,
            plan=plan,
        )
    finally:
        ssh.close()


async def provision_team_network(
    *,
    team_name: str,
    subnet: str,
    slot: TeamSlot | None,
) -> NetworkTeamProvisionResult:
    """팀 생성과 함께 라우터 inventory/OpenVPN/iptables를 구성한다."""
    return await asyncio.to_thread(
        _provision_team_network_blocking,
        team_name=team_name,
        subnet=subnet,
        slot=slot,
    )
