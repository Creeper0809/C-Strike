"""팀 삭제 시 원격 팀 서버 런타임 정리 유틸리티."""

from __future__ import annotations

import asyncio
import re
import shlex
from dataclasses import dataclass

import paramiko


class RuntimeTeamCleanupError(RuntimeError):
    """원격 팀 서버 런타임 정리 실패."""


@dataclass(frozen=True)
class RuntimeTeamCleanupResult:
    host: str
    removed_count: int
    removed_names: tuple[str, ...]
    network_removed: bool
    stdout: str
    stderr: str


def _safe_team_runtime_slug(team_code: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", (team_code or "").lower()).strip("-")
    return slug or "team"


def runtime_team_cleanup_enabled(
    *,
    gateway_ip: str | None,
    ssh_user: str | None,
    ssh_password: str | None,
    team_code: str | None,
) -> bool:
    """팀 서버 SSH 정보가 있으면 런타임 정리를 시도할 수 있다."""
    return bool(
        (gateway_ip or "").strip()
        and (ssh_user or "").strip()
        and ssh_password
        and (team_code or "").strip()
    )


def _connect_team_host(
    *,
    gateway_ip: str,
    ssh_port: int,
    ssh_user: str,
    ssh_password: str,
) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=gateway_ip,
        port=ssh_port,
        username=ssh_user,
        password=ssh_password,
        look_for_keys=False,
        allow_agent=False,
        timeout=30,
        auth_timeout=30,
        banner_timeout=30,
    )
    return client


def _parse_cleanup_output(*, host: str, stdout: str, stderr: str) -> RuntimeTeamCleanupResult:
    kv: dict[str, str] = {}
    for line in stdout.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        kv[key.strip()] = value.strip()

    removed_names_raw = kv.get("REMOVED_NAMES", "")
    removed_names = tuple(
        item.strip()
        for item in removed_names_raw.split(",")
        if item.strip()
    )
    removed_count = int(kv.get("REMOVED_COUNT", "0") or "0")
    network_removed = kv.get("NETWORK_REMOVED", "false").lower() == "true"

    return RuntimeTeamCleanupResult(
        host=host,
        removed_count=removed_count,
        removed_names=removed_names,
        network_removed=network_removed,
        stdout=stdout,
        stderr=stderr,
    )


def _cleanup_team_runtime_blocking(
    *,
    gateway_ip: str,
    ssh_port: int,
    ssh_user: str,
    ssh_password: str,
    team_code: str,
) -> RuntimeTeamCleanupResult:
    ssh = _connect_team_host(
        gateway_ip=gateway_ip,
        ssh_port=ssh_port,
        ssh_user=ssh_user,
        ssh_password=ssh_password,
    )
    try:
        quoted_team_code = shlex.quote(team_code)
        quoted_team_runtime_slug = shlex.quote(_safe_team_runtime_slug(team_code))
        remote_script = "\n".join(
            [
                "set -euo pipefail",
                f"TEAM_CODE={quoted_team_code}",
                f"TEAM_RUNTIME_SLUG={quoted_team_runtime_slug}",
                'NETWORK_NAME="cstrike-team-${TEAM_RUNTIME_SLUG}"',
                'FLAG_GLOB="/opt/cstrike-flags/cstrike-${TEAM_RUNTIME_SLUG}-*"',
                "mapfile -t CONTAINER_NAMES < <(",
                "  docker ps -a "
                '    --filter label=cstrike-service=true '
                '    --filter "label=cstrike-team-code=${TEAM_CODE}" '
                "    --format '{{.Names}}'",
                ")",
                'if ((${#CONTAINER_NAMES[@]})); then',
                '  docker rm -f "${CONTAINER_NAMES[@]}" >/dev/null',
                "fi",
                'NETWORK_REMOVED="false"',
                'if docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then',
                '  docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 || true',
                '  NETWORK_REMOVED="true"',
                "fi",
                'rm -rf ${FLAG_GLOB} 2>/dev/null || true',
                'printf "REMOVED_COUNT=%s\\n" "${#CONTAINER_NAMES[@]}"',
                'printf "REMOVED_NAMES=%s\\n" "$(IFS=,; echo "${CONTAINER_NAMES[*]-}")"',
                'printf "NETWORK_REMOVED=%s\\n" "${NETWORK_REMOVED}"',
            ]
        )

        stdin, stdout, stderr = ssh.exec_command(
            f"/bin/bash -lc {shlex.quote(remote_script)}",
            timeout=60,
        )
        out = stdout.read().decode()
        err = stderr.read().decode().strip()
        exit_code = stdout.channel.recv_exit_status()
        if exit_code != 0:
            raise RuntimeTeamCleanupError(
                f"팀 서버 런타임 정리 실패(host={gateway_ip}): {err or out or f'exit={exit_code}'}"
            )

        return _parse_cleanup_output(host=gateway_ip, stdout=out, stderr=err)
    finally:
        ssh.close()


async def cleanup_team_runtime(
    *,
    gateway_ip: str,
    ssh_port: int,
    ssh_user: str,
    ssh_password: str,
    team_code: str,
) -> RuntimeTeamCleanupResult:
    """팀 서버에 SSH로 접속해 팀 컨테이너/네트워크/플래그 디렉터리를 정리한다."""
    return await asyncio.to_thread(
        _cleanup_team_runtime_blocking,
        gateway_ip=gateway_ip,
        ssh_port=ssh_port,
        ssh_user=ssh_user,
        ssh_password=ssh_password,
        team_code=team_code,
    )
