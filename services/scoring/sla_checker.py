"""SLA 체크 모듈.

각 팀의 각 서비스에 대해 HTTP GET / TCP connect 헬스체크를 수행하고,
결과를 sla_checks 테이블에 기록한다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from uuid import UUID, uuid4

import aiohttp
from sqlalchemy import text

from .config import settings
from .database import async_session_factory
from .events import CH_SLA_DOWN, EventBus
from .health_contract import run_health_contract

logger = logging.getLogger("scoring.sla_checker")


class SLAChecker:
    """팀 서비스 SLA(가용성) 체크를 담당한다."""

    def __init__(self, event_bus: EventBus) -> None:
        self._event_bus = event_bus

    async def check_all_services(
        self,
        round_id: UUID,
        round_number: int,
        competition_id: UUID,
    ) -> list[dict]:
        """모든 활성 팀-서비스 조합에 대해 SLA 체크를 수행한다.

        Args:
            round_id: 현재 라운드 ID
            round_number: 현재 라운드 번호
            competition_id: 대회 ID

        Returns:
            SLA 체크 결과 목록
        """
        async with async_session_factory() as session:
            # 팀별 서비스 인스턴스 + 서비스 정보 조회
            result = await session.execute(
                text("""
                    SELECT
                        ts.id AS team_service_id,
                        ts.team_id,
                        ts.service_id,
                        ts.host_ip,
                        ts.port,
                        t.name AS team_name,
                        vs.name AS service_name,
                        vs.health_check_endpoint,
                        vs.healthcheck_scenarios,
                        vs.category
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
            targets = result.fetchall()

        if not targets:
            logger.warning("SLA 체크 대상이 없습니다 (competition_id=%s)", competition_id)
            return []

        # 모든 대상에 대해 병렬 SLA 체크 실행
        tasks = [
            self._check_single_service(
                round_id=round_id,
                round_number=round_number,
                target=target,
            )
            for target in targets
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 예외 발생한 결과 로깅
        sla_results = []
        for i, res in enumerate(results):
            if isinstance(res, Exception):
                logger.error(
                    "SLA 체크 예외 (team_service_id=%s): %s",
                    targets[i].team_service_id, res,
                )
            elif res is not None:
                sla_results.append(res)

        logger.info(
            "SLA 체크 완료: %d/%d 대상 처리", len(sla_results), len(targets)
        )
        return sla_results

    async def _check_single_service(
        self,
        round_id: UUID,
        round_number: int,
        target,
    ) -> dict:
        """단일 팀-서비스에 대해 SLA 체크를 수행한다."""
        host_ip = target.host_ip
        port = target.port
        health_endpoint = target.health_check_endpoint
        healthcheck_scenarios = target.healthcheck_scenarios
        check_type = self._determine_check_type(
            health_endpoint,
            healthcheck_scenarios,
            target.category,
        )

        is_up = False
        response_time_ms: int | None = None
        error_message: str | None = None

        try:
            if check_type == "custom_script" and healthcheck_scenarios:
                is_up, response_time_ms, error_message = await self._scenario_check(
                    host_ip,
                    port,
                    healthcheck_scenarios,
                )
            elif check_type == "http_get" and health_endpoint:
                is_up, response_time_ms, error_message = await self._http_check(
                    host_ip, port, health_endpoint
                )
            else:
                is_up, response_time_ms, error_message = await self._tcp_check(
                    host_ip, port
                )
        except Exception as exc:
            error_message = f"SLA 체크 예외: {exc}"
            logger.error(error_message)

        # DB에 결과 기록
        check_id = uuid4()
        async with async_session_factory() as session:
            await session.execute(
                text("""
                    INSERT INTO sla_checks
                        (id, round_id, team_id, service_id, team_service_id,
                         check_type, is_up, response_time_ms, error_message, checked_at)
                    VALUES
                        (:id, :round_id, :team_id, :service_id, :team_service_id,
                         :check_type, :is_up, :response_time_ms, :error_message, NOW())
                """),
                {
                    "id": check_id,
                    "round_id": round_id,
                    "team_id": target.team_id,
                    "service_id": target.service_id,
                    "team_service_id": target.team_service_id,
                    "check_type": check_type,
                    "is_up": is_up,
                    "response_time_ms": response_time_ms,
                    "error_message": error_message,
                },
            )
            await session.commit()

        # SLA 다운 시 Redis 이벤트 발행
        if not is_up:
            await self._event_bus.publish(CH_SLA_DOWN, {
                "team_id": str(target.team_id),
                "team_name": target.team_name,
                "service": target.service_name,
                "round_number": round_number,
            })

        return {
            "team_id": target.team_id,
            "service_id": target.service_id,
            "is_up": is_up,
            "response_time_ms": response_time_ms,
            "error_message": error_message,
        }

    async def _http_check(
        self, host: str, port: int, endpoint: str
    ) -> tuple[bool, int | None, str | None]:
        """HTTP GET 헬스체크를 수행한다."""
        url = f"http://{host}:{port}{endpoint}"
        timeout = aiohttp.ClientTimeout(total=settings.SLA_TIMEOUT_SECONDS)
        try:
            start = time.monotonic()
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.get(url) as resp:
                    elapsed_ms = int((time.monotonic() - start) * 1000)
                    is_up = resp.status == 200
                    error_msg = None if is_up else f"HTTP {resp.status}"
                    return is_up, elapsed_ms, error_msg
        except asyncio.TimeoutError:
            return False, None, f"HTTP 타임아웃 ({settings.SLA_TIMEOUT_SECONDS}초)"
        except aiohttp.ClientError as exc:
            return False, None, f"HTTP 오류: {exc}"

    async def _tcp_check(
        self, host: str, port: int
    ) -> tuple[bool, int | None, str | None]:
        """TCP connect 헬스체크를 수행한다."""
        try:
            start = time.monotonic()
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=settings.SLA_TIMEOUT_SECONDS,
            )
            elapsed_ms = int((time.monotonic() - start) * 1000)
            writer.close()
            await writer.wait_closed()
            return True, elapsed_ms, None
        except asyncio.TimeoutError:
            return False, None, f"TCP 타임아웃 ({settings.SLA_TIMEOUT_SECONDS}초)"
        except (ConnectionRefusedError, OSError) as exc:
            return False, None, f"TCP 연결 실패: {exc}"

    @staticmethod
    def _determine_check_type(
        health_endpoint: str | None,
        healthcheck_scenarios: dict | None,
        category: str,
    ) -> str:
        """서비스 정보를 기반으로 체크 방식을 결정한다."""
        if healthcheck_scenarios and isinstance(healthcheck_scenarios, dict) and healthcheck_scenarios.get("steps"):
            return "custom_script"
        if health_endpoint:
            return "http_get"
        return "tcp_connect"

    async def _scenario_check(
        self,
        host: str,
        port: int,
        scenarios: dict,
    ) -> tuple[bool, int | None, str | None]:
        return await run_health_contract(f"http://{host}:{port}", scenarios)
