"""플래그 생성/설정(Plant)/로테이션 모듈.

매 라운드마다 팀 x 서비스 조합별 고유 플래그를 생성하고,
SSH 또는 HTTP PUT으로 각 팀 서비스에 플래그를 심은 뒤,
이전 라운드의 만료 플래그를 비활성화한다.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import aiohttp

try:
    import asyncssh
except ImportError:  # 개발 환경에서 asyncssh 미설치 시 graceful 처리
    asyncssh = None  # type: ignore[assignment]

from sqlalchemy import text

from .config import settings
from .database import async_session_factory

logger = logging.getLogger("scoring.flag_manager")

# 플래그 호스트 경로 기준 (deployer.py FLAG_BASE_DIR과 동일)
FLAG_BASE_DIR = "/opt/cstrike-flags"
FLAG_PREFIX = "FLAG{"
FLAG_SUFFIX = "}"


def _safe_service_slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", (name or "").lower()).strip("-")
    return slug or "service"


def _safe_team_runtime_slug(team_code: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", (team_code or "").lower()).strip("-")
    return slug or "team"


def _sanitize_flag_filename(value: str | None, fallback_key: str) -> str:
    raw = (value or "").strip()
    if not raw:
        raw = f"flag-{fallback_key}.txt"
    name = raw.rsplit("/", 1)[-1].replace("\\", "")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    if not name:
        name = f"flag-{fallback_key}.txt"
    if not name.lower().endswith(".txt"):
        name = f"{name}.txt"
    return name


def _normalize_service_flag_slots(raw_slots, fallback_score: int) -> list[dict]:
    slots = raw_slots or [
        {
            "slot_key": "flag-1",
            "label": "플래그 1",
            "filename": "flag.txt",
            "points": fallback_score,
        }
    ]
    normalized: list[dict] = []
    for index, slot in enumerate(slots, start=1):
        slot = slot or {}
        slot_key = re.sub(
            r"[^a-z0-9._-]+",
            "-",
            str(slot.get("slot_key") or slot.get("filename") or slot.get("label") or f"flag-{index}").strip().lower(),
        ).strip("-") or f"flag-{index}"
        normalized.append(
            {
                "slot_key": slot_key,
                "label": str(slot.get("label") or f"플래그 {index}").strip() or f"플래그 {index}",
                "filename": _sanitize_flag_filename(slot.get("filename"), slot_key),
                "points": max(int(slot.get("points") or fallback_score or 100), 1),
            }
        )
    return normalized


def build_plant_ssh_command(flag_value: str, team_code: str, service_name: str, filename: str) -> str:
    """SSH로 실행할 플래그 심기 명령을 생성한다.

    호스트의 /opt/cstrike-flags/{container_name}/{filename}에 쓴다.
    컨테이너는 이 파일을 :ro로 마운트하므로 자동 반영된다.
    """
    container_name = f"cstrike-{_safe_team_runtime_slug(team_code)}-{_safe_service_slug(service_name)}"
    host_path = f"{FLAG_BASE_DIR}/{container_name}/{_sanitize_flag_filename(filename, 'flag')}"
    safe_value = flag_value.replace("'", "'\\''")
    return f"echo '{safe_value}' > {host_path}"


def generate_flag_value(
    *,
    team_code: str,
    service_name: str,
    slot_key: str,
    points: int,
    round_number: int,
) -> str:
    """운영 메타데이터를 외부에 노출하지 않는 불투명 플래그 값을 생성한다."""
    nonce = secrets.token_hex(8)
    payload = (
        f"v=1;"
        f"t={team_code};"
        f"s={_safe_service_slug(service_name)};"
        f"k={slot_key};"
        f"p={int(points)};"
        f"r={int(round_number)};"
        f"n={nonce}"
    )
    digest = hmac.new(
        settings.FLAG_HMAC_SECRET.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]
    return f"{FLAG_PREFIX}{digest}{FLAG_SUFFIX}"



class FlagManager:
    """플래그 생성, 만료 처리를 담당한다."""

    async def generate_flags(
        self,
        round_id: UUID,
        competition_id: UUID,
        scoring_interval_seconds: int,
        flag_lifetime_rounds: int = 2,
    ) -> list[dict]:
        """현재 라운드의 플래그를 생성하고 DB에 삽입한다.

        Args:
            round_id: 현재 라운드 ID
            competition_id: 대회 ID
            scoring_interval_seconds: 라운드 간격 (초)
            flag_lifetime_rounds: 플래그 유효 라운드 수

        Returns:
            생성된 플래그 목록 [{team_id, service_id, slot_key, flag_value, flag_id}, ...]
        """
        async with async_session_factory() as session:
            round_info_result = await session.execute(
                text("""
                    SELECT round_number
                    FROM scoring_rounds
                    WHERE id = :round_id
                """),
                {"round_id": round_id},
            )
            round_info = round_info_result.fetchone()
            round_number = int(round_info.round_number) if round_info else 0

            # 1) 활성 팀 목록 조회 (status = 'active' 또는 'approved')
            teams_result = await session.execute(
                text("""
                    SELECT id, name, team_code FROM teams
                    WHERE competition_id = :comp_id
                      AND status IN ('active', 'approved')
                    ORDER BY name
                """),
                {"comp_id": competition_id},
            )
            teams = teams_result.fetchall()

            # 2) 활성 서비스 목록 조회
            services_result = await session.execute(
                text("""
                    SELECT id, name, score, flag_slots FROM vuln_services
                    WHERE (competition_id = :comp_id OR competition_id IS NULL)
                      AND status = 'active'
                    ORDER BY name
                """),
                {"comp_id": competition_id},
            )
            services = services_result.fetchall()

            if not teams:
                logger.warning("활성 팀이 없습니다 (competition_id=%s)", competition_id)
                return []
            if not services:
                logger.warning("활성 서비스가 없습니다 (competition_id=%s)", competition_id)
                return []

            # 3) 팀 x 서비스 조합별 플래그 생성
            now = datetime.now(timezone.utc)
            expires_at = now + timedelta(seconds=scoring_interval_seconds * flag_lifetime_rounds)

            flags: list[dict] = []
            for team in teams:
                for service in services:
                    flag_slots = _normalize_service_flag_slots(service.flag_slots, int(service.score or 100))
                    for slot in flag_slots:
                        flag_id = uuid4()
                        flag_value = generate_flag_value(
                            team_code=team.team_code,
                            service_name=service.name,
                            slot_key=slot["slot_key"],
                            points=slot["points"],
                            round_number=round_number,
                        )
                        flags.append({
                            "id": flag_id,
                            "round_id": round_id,
                            "team_id": team.id,
                            "service_id": service.id,
                            "slot_key": slot["slot_key"],
                            "slot_label": slot["label"],
                            "flag_filename": slot["filename"],
                            "point_value": slot["points"],
                            "flag_value": flag_value,
                            "is_active": True,
                            "expires_at": expires_at,
                        })

            # 4) 일괄 삽입
            if flags:
                await session.execute(
                    text("""
                        INSERT INTO flags (
                            id, round_id, team_id, service_id, slot_key, slot_label,
                            flag_filename, point_value, flag_value, is_active, expires_at, created_at
                        )
                        VALUES (
                            :id, :round_id, :team_id, :service_id, :slot_key, :slot_label,
                            :flag_filename, :point_value, :flag_value, :is_active, :expires_at, NOW()
                        )
                    """),
                    flags,
                )
                await session.commit()
                logger.info(
                    "플래그 %d개 생성 완료 (팀 %d × 서비스 %d)",
                    len(flags), len(teams), len(services),
                )

            return flags

    async def plant_flags(
        self,
        round_id: UUID,
        competition_id: UUID,
        flags: list[dict],
    ) -> dict:
        """생성된 플래그를 각 팀 서비스에 SSH 또는 HTTP PUT으로 심는다.

        기획서 Step 3 — 플래그 설정(Plant):
        - vuln_services.flag_format에 따라 SSH(file) / HTTP PUT(api) 분기
        - Semaphore(MAX_CONCURRENT_SSH)로 동시성 제어
        - 타임아웃 FLAG_PLANT_TIMEOUT_SECONDS, 최대 FLAG_PLANT_RETRY_COUNT회 재시도
        - 성공 시 flags.planted_at 타임스탬프 갱신
        - 실패 시 해당 플래그 is_active=False 처리 + 로그

        Args:
            round_id: 현재 라운드 ID
            competition_id: 대회 ID
            flags: generate_flags()가 반환한 플래그 목록

        Returns:
            {"success": int, "failed": int, "total": int}
        """
        if not flags:
            logger.warning("plant 대상 플래그가 없습니다")
            return {"success": 0, "failed": 0, "total": 0}

        # 팀-서비스 인스턴스 접속 정보 + flag_format 조회
        targets = await self._fetch_plant_targets(competition_id)
        if not targets:
            logger.warning("plant 대상 팀-서비스 인스턴스가 없습니다 (competition_id=%s)", competition_id)
            return {"success": 0, "failed": 0, "total": len(flags)}

        # (team_id, service_id) → 접속 정보 매핑
        target_map: dict[tuple, dict] = {}
        for t in targets:
            key = (str(t["team_id"]), str(t["service_id"]))
            target_map[key] = t

        # 동시성 제어용 세마포어
        semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_SSH)

        async def _plant_one(flag: dict) -> bool:
            """단일 플래그를 팀 서비스에 심는다. 성공 시 True."""
            key = (str(flag["team_id"]), str(flag["service_id"]))
            target = target_map.get(key)
            if target is None:
                logger.warning(
                    "plant 대상 없음: team_id=%s, service_id=%s, slot=%s",
                    flag["team_id"], flag["service_id"], flag.get("slot_key"),
                )
                await self._mark_flag_inactive(flag["id"])
                return False

            async with semaphore:
                return await self._plant_single_flag_with_retry(flag, target)

        # 모든 플래그에 대해 병렬 실행
        results = await asyncio.gather(
            *[_plant_one(f) for f in flags],
            return_exceptions=True,
        )

        success_count = 0
        fail_count = 0
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(
                    "plant 예외: flag_id=%s, slot=%s, error=%s",
                    flags[i]["id"], flags[i].get("slot_key"), result,
                )
                await self._mark_flag_inactive(flags[i]["id"])
                fail_count += 1
            elif result:
                success_count += 1
            else:
                fail_count += 1

        logger.info(
            "플래그 plant 완료: 성공=%d, 실패=%d, 전체=%d",
            success_count, fail_count, len(flags),
        )
        return {"success": success_count, "failed": fail_count, "total": len(flags)}

    # ── plant 내부 헬퍼 ──

    async def _fetch_plant_targets(self, competition_id: UUID) -> list[dict]:
        """plant에 필요한 팀-서비스 인스턴스 접속 정보를 조회한다."""
        async with async_session_factory() as session:
            result = await session.execute(
                text("""
                    SELECT
                        ts.team_id,
                        ts.service_id,
                        ts.host_ip,
                        ts.port AS service_port,
                        vs.flag_format,
                        vs.name AS service_name,
                        t.team_code,
                        t.ssh_port,
                        t.ssh_user,
                        t.ssh_password
                    FROM team_services ts
                    JOIN teams t ON ts.team_id = t.id
                    JOIN vuln_services vs ON ts.service_id = vs.id
                    WHERE t.competition_id = :comp_id
                      AND t.status IN ('active', 'approved')
                      AND ts.status = 'running'
                      AND vs.status = 'active'
                """),
                {"comp_id": competition_id},
            )
            rows = result.fetchall()
            return [
                {
                    "team_id": row.team_id,
                    "service_id": row.service_id,
                    "host_ip": row.host_ip,
                    "service_port": row.service_port,
                    "flag_format": row.flag_format,
                    "service_name": row.service_name,
                    "team_code": row.team_code,
                    "ssh_port": row.ssh_port or 22,
                    "ssh_user": row.ssh_user,
                    "ssh_password": row.ssh_password,
                }
                for row in rows
            ]

    async def _plant_single_flag_with_retry(self, flag: dict, target: dict) -> bool:
        """단일 플래그를 재시도 로직과 함께 심는다.

        최대 시도 횟수 = 1(초기) + FLAG_PLANT_RETRY_COUNT(재시도)
        재시도 간격 = FLAG_PLANT_RETRY_DELAY_SECONDS
        """
        max_attempts = 1 + settings.FLAG_PLANT_RETRY_COUNT
        last_error: str = ""

        for attempt in range(1, max_attempts + 1):
            try:
                flag_format = (target.get("flag_format") or "").lower()
                if flag_format == "api":
                    await self._plant_via_http(
                        host_ip=target["host_ip"],
                        port=target["service_port"],
                        flag_value=flag["flag_value"],
                    )
                else:
                    # 기본값: SSH 파일 기반 (file, 또는 기타 형식)
                    await self._plant_via_ssh(
                        host_ip=target["host_ip"],
                        flag_value=flag["flag_value"],
                        filename=flag["flag_filename"],
                        target=target,
                    )

                # 성공: planted_at 타임스탬프 갱신
                await self._mark_flag_planted(flag["id"])
                return True

            except Exception as exc:
                last_error = str(exc)
                logger.warning(
                    "plant 시도 %d/%d 실패: team=%s, service=%s, slot=%s, error=%s",
                    attempt, max_attempts,
                    flag["team_id"], flag["service_id"], flag.get("slot_key"), last_error,
                )
                if attempt < max_attempts:
                    await asyncio.sleep(settings.FLAG_PLANT_RETRY_DELAY_SECONDS)

        # 최종 실패: is_active=False 처리
        logger.error(
            "plant 최종 실패: flag_id=%s, team=%s, service=%s, slot=%s, last_error=%s",
            flag["id"], flag["team_id"], flag["service_id"], flag.get("slot_key"), last_error,
        )
        await self._mark_flag_inactive(flag["id"])
        return False

    async def _plant_via_ssh(
        self,
        host_ip: str,
        flag_value: str,
        filename: str,
        target: dict | None = None,
    ) -> None:
        """SSH로 플래그를 호스트 파일시스템에 심는다.

        호스트의 /opt/cstrike-flags/{container_name}/{filename} 에 쓴다.
        컨테이너는 이 파일을 :ro로 마운트하여 자동 반영된다.
        """
        if asyncssh is None:
            raise RuntimeError("asyncssh 패키지가 설치되지 않았습니다")

        if not target or not target.get("team_code") or not target.get("service_name"):
            raise RuntimeError("plant 대상에 team_code/service_name이 없습니다")

        timeout = settings.FLAG_PLANT_TIMEOUT_SECONDS

        connect_kwargs: dict = {
            "host": host_ip,
            "known_hosts": None,
            "connect_timeout": timeout,
        }

        if target and target.get("ssh_user") and target.get("ssh_password"):
            connect_kwargs["port"] = target.get("ssh_port", 22)
            connect_kwargs["username"] = target["ssh_user"]
            from .crypto_util import decrypt_password
            connect_kwargs["password"] = decrypt_password(target["ssh_password"])
        else:
            connect_kwargs["port"] = 22
            connect_kwargs["username"] = settings.SSH_USER
            connect_kwargs["client_keys"] = [settings.SSH_KEY_PATH]

        plant_cmd = build_plant_ssh_command(
            flag_value=flag_value,
            team_code=target["team_code"],
            service_name=target["service_name"],
            filename=filename,
        )

        async with asyncssh.connect(**connect_kwargs) as conn:
            result = await asyncio.wait_for(
                conn.run(plant_cmd, check=True),
                timeout=timeout,
            )
            if result.exit_status != 0:
                raise RuntimeError(f"SSH 명령 실패: exit_status={result.exit_status}")

    async def _plant_via_http(self, host_ip: str, port: int, flag_value: str) -> None:
        """HTTP PUT으로 플래그를 팀 서비스 API에 심는다."""
        url = f"http://{host_ip}:{port}/api/flag"
        timeout = aiohttp.ClientTimeout(total=settings.FLAG_PLANT_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as client:
            async with client.put(url, json={"flag": flag_value}) as resp:
                if resp.status not in (200, 201, 204):
                    body = await resp.text()
                    raise RuntimeError(
                        f"HTTP PUT 실패: status={resp.status}, body={body[:200]}"
                    )

    async def _mark_flag_planted(self, flag_id: UUID) -> None:
        """플래그의 planted_at 타임스탬프를 현재 시각으로 갱신한다."""
        async with async_session_factory() as session:
            await session.execute(
                text("UPDATE flags SET planted_at = NOW() WHERE id = :flag_id"),
                {"flag_id": flag_id},
            )
            await session.commit()

    async def _mark_flag_inactive(self, flag_id: UUID) -> None:
        """plant 실패한 플래그를 비활성화한다."""
        async with async_session_factory() as session:
            await session.execute(
                text("UPDATE flags SET is_active = false WHERE id = :flag_id"),
                {"flag_id": flag_id},
            )
            await session.commit()
        logger.warning("플래그 비활성화: flag_id=%s (plant 실패)", flag_id)

    async def expire_old_flags(self) -> int:
        """만료된 플래그를 비활성화한다.

        Returns:
            비활성화된 플래그 수
        """
        async with async_session_factory() as session:
            result = await session.execute(
                text("""
                    UPDATE flags
                    SET is_active = false
                    WHERE is_active = true
                      AND expires_at <= NOW()
                """)
            )
            await session.commit()
            count = result.rowcount
            if count > 0:
                logger.info("만료 플래그 %d개 비활성화 완료", count)
            return count
