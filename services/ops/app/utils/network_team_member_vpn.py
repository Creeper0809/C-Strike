"""팀원 단위 OpenVPN 계정 발급/비활성화 유틸리티."""

from __future__ import annotations

import asyncio
import csv
import io
import ipaddress
import re
import shlex
from dataclasses import dataclass

import paramiko

from app.config import settings
from app.utils.network_team_cleanup import (
    InventoryTeamRow,
    _parse_inventory_rows,
    _resolve_team_alias,
)


class NetworkTeamMemberVpnError(RuntimeError):
    """팀원 VPN 계정 발급/정리 실패."""


@dataclass(frozen=True)
class VpnUserRow:
    username: str
    display_name: str
    role: str
    team_alias: str
    status: str
    vpn_ip: str


@dataclass(frozen=True)
class TeamMemberVpnProvisionResult:
    team_alias: str
    vpn_username: str
    vpn_ip: str
    generated_password: str | None
    created: bool
    reactivated: bool
    password_reset: bool
    stdout: str
    stderr: str


@dataclass(frozen=True)
class TeamMemberVpnDisableResult:
    team_alias: str
    vpn_username: str
    disabled: bool
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


def network_team_member_vpn_enabled() -> bool:
    """팀원 단위 VPN 자동화를 사용할지."""
    return bool(
        settings.NETWORK_TEAM_PROVISION_ENABLED
        and _effective_host()
        and _effective_user()
        and _effective_password()
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


def _read_remote_csv(ssh: paramiko.SSHClient, path: str) -> str:
    if _effective_use_sudo():
        command = f"sudo -S -p '' cat {shlex.quote(path)}"
    else:
        command = f"cat {shlex.quote(path)}"

    stdin, stdout, stderr = ssh.exec_command(command, timeout=_effective_timeout())
    if _effective_use_sudo():
        stdin.write(_effective_password() + "\n")
        stdin.flush()

    data = stdout.read().decode()
    error = stderr.read().decode().strip()
    exit_code = stdout.channel.recv_exit_status()
    if exit_code != 0:
        raise NetworkTeamMemberVpnError(
            f"라우터 파일 조회 실패: {error or path}"
        )
    return data


def _read_remote_teams(ssh: paramiko.SSHClient) -> list[InventoryTeamRow]:
    raw = _read_remote_csv(ssh, f"{_effective_root()}/inventory/teams.csv")
    return _parse_inventory_rows(raw)


def _parse_vpn_user_rows(raw_csv: str) -> list[VpnUserRow]:
    reader = csv.DictReader(io.StringIO(raw_csv))
    rows: list[VpnUserRow] = []
    for row in reader:
        rows.append(
            VpnUserRow(
                username=(row.get("username") or "").strip(),
                display_name=(row.get("display_name") or "").strip(),
                role=(row.get("role") or "").strip(),
                team_alias=(row.get("team_alias") or "").strip(),
                status=(row.get("status") or "").strip(),
                vpn_ip=(row.get("vpn_ip") or "").strip(),
            )
        )
    return rows


def _read_remote_vpn_users(ssh: paramiko.SSHClient) -> list[VpnUserRow]:
    raw = _read_remote_csv(ssh, f"{_effective_root()}/inventory/vpn-users.csv")
    return _parse_vpn_user_rows(raw)


def build_team_member_vpn_username(*, team_alias: str, member_sequence: int) -> str:
    if member_sequence < 1:
        raise NetworkTeamMemberVpnError("팀원 VPN 계정 순번은 1 이상이어야 합니다.")
    return f"team-{team_alias}-user{member_sequence:02d}"


def _find_team_row(
    rows: list[InventoryTeamRow],
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
) -> InventoryTeamRow:
    team_alias = _resolve_team_alias(
        rows,
        team_name=team_name,
        subnet=subnet,
        gateway_ip=gateway_ip,
    )
    if not team_alias:
        raise NetworkTeamMemberVpnError(
            "네트워크 inventory에서 팀 alias를 찾지 못했습니다."
        )

    for row in rows:
        if row.status == "active" and row.team_alias == team_alias:
            return row

    raise NetworkTeamMemberVpnError(
        f"active 팀 슬롯을 찾지 못했습니다 (alias={team_alias})."
    )


def _allocate_vpn_ip(team_row: InventoryTeamRow, users: list[VpnUserRow]) -> str:
    try:
        network = ipaddress.ip_network(team_row.vpn_prefix, strict=False)
    except ValueError as exc:
        raise NetworkTeamMemberVpnError(
            f"잘못된 팀 VPN 대역입니다: {team_row.vpn_prefix}"
        ) from exc

    reserved = {
        row.vpn_ip
        for row in users
        if row.team_alias == team_row.team_alias and row.vpn_ip
    }

    for host in range(10, 201):
        candidate = str(network.network_address + host)
        if candidate not in reserved:
            return candidate

    raise NetworkTeamMemberVpnError(
        f"{team_row.team_alias} 팀 VPN 대역에서 사용 가능한 IP를 찾지 못했습니다."
    )


def _parse_password_block(output: str) -> str | None:
    match = re.search(
        r"__VPN_PASSWORD_BEGIN__\n(?P<body>.*?)\n__VPN_PASSWORD_END__",
        output,
        re.DOTALL,
    )
    if not match:
        return None
    for line in match.group("body").splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    return None


def _run_remote_member_upsert(
    ssh: paramiko.SSHClient,
    *,
    vpn_username: str,
    display_name: str,
    team_alias: str,
    vpn_ip: str,
    issue_password: bool,
) -> tuple[str, str, str | None]:
    root = _effective_root()
    timeout = _effective_timeout()
    users_path = f"{root}/inventory/vpn-users.csv"
    gen_users_script = f"{root}/scripts/gen-vpn-users.sh"
    apply_users_script = f"{root}/scripts/apply-vpn-users.sh"
    gen_ccd_script = f"{root}/scripts/gen-openvpn-ccd.sh"
    reset_password_script = f"{root}/scripts/reset-vpn-password.sh"

    python_upsert = "\n".join(
        [
            "python3 - "
            + " ".join(
                shlex.quote(value)
                for value in (
                    users_path,
                    vpn_username,
                    display_name,
                    team_alias,
                    vpn_ip,
                )
            )
            + " <<'PY'",
            "import csv",
            "import pathlib",
            "import sys",
            "import tempfile",
            "path = pathlib.Path(sys.argv[1])",
            "username, display_name, team_alias, vpn_ip = sys.argv[2:6]",
            "fieldnames = ['username', 'display_name', 'role', 'team_alias', 'status', 'vpn_ip']",
            "rows = []",
            "updated = False",
            "with path.open(newline='') as fh:",
            "    reader = csv.DictReader(fh)",
            "    for row in reader:",
            "        if (row.get('username') or '').strip() == username:",
            "            row['display_name'] = display_name",
            "            row['role'] = 'team'",
            "            row['team_alias'] = team_alias",
            "            row['status'] = 'active'",
            "            row['vpn_ip'] = vpn_ip",
            "            updated = True",
            "        rows.append({key: (row.get(key) or '') for key in fieldnames})",
            "if not updated:",
            "    rows.append({",
            "        'username': username,",
            "        'display_name': display_name,",
            "        'role': 'team',",
            "        'team_alias': team_alias,",
            "        'status': 'active',",
            "        'vpn_ip': vpn_ip,",
            "    })",
            "with tempfile.NamedTemporaryFile('w', delete=False, dir=str(path.parent), newline='') as fh:",
            "    writer = csv.DictWriter(fh, fieldnames=fieldnames)",
            "    writer.writeheader()",
            "    writer.writerows(rows)",
            "    temp_name = fh.name",
            "pathlib.Path(temp_name).replace(path)",
            "print('updated=' + ('1' if updated else '0'))",
            "PY",
        ]
    )

    commands = [
        "set -euo pipefail",
        "install -d -o root -g nogroup -m 750 /etc/openvpn/server/ccd",
        python_upsert,
        f"{shlex.quote(gen_users_script)} --root {shlex.quote(root)}",
        f"{shlex.quote(apply_users_script)} --root {shlex.quote(root)} --execute",
        f"{shlex.quote(gen_ccd_script)} --root {shlex.quote(root)}",
        (
            "if [[ -f "
            + shlex.quote(f"{root}/openvpn/ccd/{vpn_username}")
            + " ]]; then "
            + "install -o root -g nogroup -m 640 "
            + shlex.quote(f"{root}/openvpn/ccd/{vpn_username}")
            + " "
            + shlex.quote(f"/etc/openvpn/server/ccd/{vpn_username}")
            + "; else rm -f "
            + shlex.quote(f"/etc/openvpn/server/ccd/{vpn_username}")
            + "; fi"
        ),
    ]
    if issue_password:
        commands.extend(
            [
                "echo '__VPN_PASSWORD_BEGIN__'",
                f"{shlex.quote(reset_password_script)} --root {shlex.quote(root)} --username {shlex.quote(vpn_username)} --execute",
                "echo '__VPN_PASSWORD_END__'",
            ]
        )
    commands.append("systemctl reload openvpn-server@server || systemctl restart openvpn-server@server")

    remote_script = "\n".join(commands)
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
        raise NetworkTeamMemberVpnError(
            f"팀원 VPN 계정 반영 실패(username={vpn_username}): "
            f"{err or out or f'exit={exit_code}'}"
        )
    return out, err, _parse_password_block(out)


def _run_remote_member_disable(
    ssh: paramiko.SSHClient,
    *,
    vpn_username: str,
) -> tuple[bool, str, str]:
    root = _effective_root()
    timeout = _effective_timeout()
    users_path = f"{root}/inventory/vpn-users.csv"
    gen_users_script = f"{root}/scripts/gen-vpn-users.sh"
    apply_users_script = f"{root}/scripts/apply-vpn-users.sh"
    gen_ccd_script = f"{root}/scripts/gen-openvpn-ccd.sh"

    python_disable = "\n".join(
        [
            "python3 - " + " ".join(shlex.quote(value) for value in (users_path, vpn_username)) + " <<'PY'",
            "import csv",
            "import pathlib",
            "import sys",
            "import tempfile",
            "path = pathlib.Path(sys.argv[1])",
            "username = sys.argv[2]",
            "fieldnames = ['username', 'display_name', 'role', 'team_alias', 'status', 'vpn_ip']",
            "rows = []",
            "updated = False",
            "with path.open(newline='') as fh:",
            "    reader = csv.DictReader(fh)",
            "    for row in reader:",
            "        if (row.get('username') or '').strip() == username:",
            "            row['status'] = 'disabled'",
            "            updated = True",
            "        rows.append({key: (row.get(key) or '') for key in fieldnames})",
            "if updated:",
            "    with tempfile.NamedTemporaryFile('w', delete=False, dir=str(path.parent), newline='') as fh:",
            "        writer = csv.DictWriter(fh, fieldnames=fieldnames)",
            "        writer.writeheader()",
            "        writer.writerows(rows)",
            "        temp_name = fh.name",
            "    pathlib.Path(temp_name).replace(path)",
            "print('updated=' + ('1' if updated else '0'))",
            "PY",
        ]
    )

    remote_script = "\n".join(
        [
            "set -euo pipefail",
            python_disable,
            "if grep -q 'updated=1' <<'EOF'\n$(true)\nEOF; then :; fi",
        ]
    )
    # grep hack is ugly; use shell variable instead.
    remote_script = "\n".join(
        [
            "set -euo pipefail",
            "install -d -o root -g nogroup -m 750 /etc/openvpn/server/ccd",
            f"result=$({python_disable})",
            'printf "%s\\n" "$result"',
            'if [[ "$result" == *"updated=1"* ]]; then',
            f"  {shlex.quote(gen_users_script)} --root {shlex.quote(root)}",
            f"  {shlex.quote(apply_users_script)} --root {shlex.quote(root)} --execute",
            f"  {shlex.quote(gen_ccd_script)} --root {shlex.quote(root)}",
            "  if [[ -f "
            + shlex.quote(f"{root}/openvpn/ccd/{vpn_username}")
            + " ]]; then "
            + "install -o root -g nogroup -m 640 "
            + shlex.quote(f"{root}/openvpn/ccd/{vpn_username}")
            + " "
            + shlex.quote(f"/etc/openvpn/server/ccd/{vpn_username}")
            + "; else rm -f "
            + shlex.quote(f"/etc/openvpn/server/ccd/{vpn_username}")
            + "; fi",
            "  systemctl reload openvpn-server@server || systemctl restart openvpn-server@server",
            "fi",
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
        raise NetworkTeamMemberVpnError(
            f"팀원 VPN 계정 비활성화 실패(username={vpn_username}): "
            f"{err or out or f'exit={exit_code}'}"
        )
    return ("updated=1" in out), out, err


def _provision_team_member_vpn_blocking(
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
    member_sequence: int,
    member_display_name: str,
    issue_password: bool,
) -> TeamMemberVpnProvisionResult:
    if not network_team_member_vpn_enabled():
        raise NetworkTeamMemberVpnError("팀원 VPN 자동화가 비활성화되어 있습니다.")

    ssh = _connect_router()
    try:
        team_rows = _read_remote_teams(ssh)
        team_row = _find_team_row(
            team_rows,
            team_name=team_name,
            subnet=subnet,
            gateway_ip=gateway_ip,
        )
        user_rows = _read_remote_vpn_users(ssh)
        vpn_username = build_team_member_vpn_username(
            team_alias=team_row.team_alias,
            member_sequence=member_sequence,
        )
        existing_row = next((row for row in user_rows if row.username == vpn_username), None)
        if existing_row is not None and existing_row.team_alias not in {"", team_row.team_alias}:
            raise NetworkTeamMemberVpnError(
                f"VPN username 충돌이 발생했습니다: {vpn_username}"
            )

        vpn_ip = existing_row.vpn_ip if existing_row and existing_row.vpn_ip else _allocate_vpn_ip(team_row, user_rows)
        created = existing_row is None
        reactivated = bool(existing_row and existing_row.status != "active")
        password_reset = bool(issue_password)
        stdout, stderr, generated_password = _run_remote_member_upsert(
            ssh,
            vpn_username=vpn_username,
            display_name=member_display_name,
            team_alias=team_row.team_alias,
            vpn_ip=vpn_ip,
            issue_password=password_reset,
        )
        return TeamMemberVpnProvisionResult(
            team_alias=team_row.team_alias,
            vpn_username=vpn_username,
            vpn_ip=vpn_ip,
            generated_password=generated_password,
            created=created,
            reactivated=reactivated,
            password_reset=password_reset,
            stdout=stdout,
            stderr=stderr,
        )
    finally:
        ssh.close()


def _disable_team_member_vpn_blocking(
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
    member_sequence: int,
) -> TeamMemberVpnDisableResult | None:
    if not network_team_member_vpn_enabled():
        return None

    ssh = _connect_router()
    try:
        team_rows = _read_remote_teams(ssh)
        team_row = _find_team_row(
            team_rows,
            team_name=team_name,
            subnet=subnet,
            gateway_ip=gateway_ip,
        )
        vpn_username = build_team_member_vpn_username(
            team_alias=team_row.team_alias,
            member_sequence=member_sequence,
        )
        disabled, stdout, stderr = _run_remote_member_disable(
            ssh,
            vpn_username=vpn_username,
        )
        return TeamMemberVpnDisableResult(
            team_alias=team_row.team_alias,
            vpn_username=vpn_username,
            disabled=disabled,
            stdout=stdout,
            stderr=stderr,
        )
    finally:
        ssh.close()


async def provision_team_member_vpn(
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
    member_sequence: int,
    member_display_name: str,
    issue_password: bool,
) -> TeamMemberVpnProvisionResult:
    """팀원 추가/재활성화 시 팀원별 OpenVPN 계정을 발급한다."""
    return await asyncio.to_thread(
        _provision_team_member_vpn_blocking,
        team_name=team_name,
        subnet=subnet,
        gateway_ip=gateway_ip,
        member_sequence=member_sequence,
        member_display_name=member_display_name,
        issue_password=issue_password,
    )


async def disable_team_member_vpn(
    *,
    team_name: str,
    subnet: str | None,
    gateway_ip: str | None,
    member_sequence: int,
) -> TeamMemberVpnDisableResult | None:
    """팀원 VPN 계정을 disabled 상태로 전환한다."""
    return await asyncio.to_thread(
        _disable_team_member_vpn_blocking,
        team_name=team_name,
        subnet=subnet,
        gateway_ip=gateway_ip,
        member_sequence=member_sequence,
    )
