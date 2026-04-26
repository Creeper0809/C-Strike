"""메인 라운드 루프 모듈.

기획서 3절의 7단계 라운드 흐름을 오케스트레이션한다:
  Step 1: 라운드 시작 (scoring_rounds INSERT, status=running)
  Step 2: 플래그 생성 (flags INSERT)
  Step 3: 플래그 설정 — Plant (SSH/HTTP PUT으로 팀 서비스에 플래그 심기)
  Step 4: SLA 체크 (sla_checks INSERT)
  Step 5: 플래그 정산 (flag_submissions verdict 업데이트)
  Step 6: 점수 계산 (team_scores INSERT)
  Step 7: 라운드 완료 (status=completed, Redis 이벤트)

대회 status=running 일 때만 실행, paused 이면 대기.
한 라운드가 실패해도 다음 라운드는 계속 진행된다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import signal
from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import text

from .auto_release import AutoReleaseChecker
from .config import settings
from .database import async_session_factory, dispose_engine
from .events import (
    CH_COMPETITION_END,
    CH_COMPETITION_START,
    CH_CONFIG_INTERVAL,
    CH_EMERGENCY_HALT,
    CH_EMERGENCY_RESUME,
    CH_ROUND_COMPLETE,
    CH_ROUND_START,
    CH_VULNPACK_RELEASED,
    EventBus,
)
from .flag_manager import FlagManager
from .score_calculator import ScoreCalculator
from .sla_checker import SLAChecker

logger = logging.getLogger("scoring.round_runner")

# 플래그 형식 정규식 (제출 검증용)
FLAG_PATTERN = re.compile(r"^FLAG\{[0-9a-f]{32}\}$")


class RoundRunner:
    """채점 엔진 메인 루프.

    대회 상태를 감시하면서 라운드를 주기적으로 실행한다.
    비상 통제(halt/resume) 및 라운드 간격 변경을 실시간으로 반영한다.
    """

    def __init__(self) -> None:
        self._event_bus = EventBus()
        self._flag_manager = FlagManager()
        self._sla_checker = SLAChecker(self._event_bus)
        self._score_calculator = ScoreCalculator()
        self._auto_release_checker = AutoReleaseChecker(event_bus=self._event_bus)

        # 실행 상태
        self._running = False
        self._halted = False  # 비상 중단 상태
        self._halt_type: str | None = None  # "graceful" | "immediate"
        self._interval_override: int | None = settings.ROUND_INTERVAL_OVERRIDE

        # graceful shutdown
        self._shutdown_event = asyncio.Event()

    # ── 공개 API ──

    async def run(self) -> None:
        """채점 엔진 메인 루프를 시작한다."""
        self._running = True
        self._setup_signal_handlers()

        # Redis 연결 및 구독
        await self._event_bus.connect()
        self._register_event_handlers()
        await self._event_bus.start_listening()

        logger.info("채점 엔진 시작 — 대회 running 상태 대기 중...")

        try:
            while self._running:
                # 종료 시그널 확인
                if self._shutdown_event.is_set():
                    logger.info("종료 시그널 수신 — 메인 루프 종료")
                    break

                # 대회 상태 확인 (running 또는 paused 포함)
                comp = await self._get_running_competition()
                if comp is None:
                    await asyncio.sleep(5)
                    continue

                competition_id = comp["id"]
                comp_status = comp["status"]
                actual_start_at = comp["actual_start_at"]
                interval = self._get_scoring_interval(comp["scoring_interval"])

                if not self._is_competition_window_open(comp):
                    logger.debug("대회 시간 창 바깥 — 라운드 실행 대기 중: competition_id=%s", competition_id)
                    await asyncio.sleep(5)
                    continue

                # ── 자동 공개 체크 (매 루프 1회, paused는 내부에서 건너뜀) ──
                try:
                    released = await self._auto_release_checker.check(
                        competition_id=competition_id,
                        actual_start_at=actual_start_at,
                        competition_status=comp_status,
                    )
                    if released > 0:
                        logger.info("자동 공개 %d개 팩 처리 완료", released)
                except Exception as exc:
                    logger.error("자동 공개 체크 실패: %s", exc, exc_info=True)

                # paused 상태 대회면 라운드 실행 없이 짧게 대기 후 재시도
                if comp_status == "paused":
                    await asyncio.sleep(5)
                    continue

                # 비상 중단 상태이면 대기
                if self._halted:
                    logger.debug("비상 중단 상태 — 재개 대기 중...")
                    await asyncio.sleep(3)
                    continue

                # 라운드 실행
                try:
                    await self._execute_round(competition_id, interval)
                except Exception as exc:
                    logger.error("라운드 실행 실패: %s", exc, exc_info=True)

                # 다음 라운드 대기 (중간에 종료/중단 시 즉시 탈출)
                try:
                    await asyncio.wait_for(
                        self._shutdown_event.wait(), timeout=interval
                    )
                    break  # shutdown 이벤트 발생
                except asyncio.TimeoutError:
                    pass  # 정상 대기 완료 → 다음 라운드

        finally:
            await self._cleanup()

    async def halt(self, halt_type: str = "graceful") -> None:
        """채점을 중단한다."""
        self._halted = True
        self._halt_type = halt_type
        logger.warning("채점 중단 요청: type=%s", halt_type)

    async def resume(self) -> None:
        """채점을 재개한다."""
        self._halted = False
        self._halt_type = None
        logger.info("채점 재개")

    # ── 라운드 실행 ──

    async def _execute_round(self, competition_id: UUID, scoring_interval: int) -> None:
        """단일 라운드의 전체 흐름을 실행한다."""
        round_id: UUID | None = None

        try:
            # Step 1: 라운드 시작
            round_id, round_number = await self._step1_start_round(competition_id)
            logger.info("[Round %d] 라운드 시작", round_number)

            # 즉시 중단 확인
            if self._halted and self._halt_type == "immediate":
                await self._cancel_round(round_id)
                return

            # Step 2: 플래그 생성
            flags = await self._step2_generate_flags(
                round_id, competition_id, scoring_interval
            )
            logger.info("[Round %d] 플래그 %d개 생성 완료", round_number, len(flags))

            # 만료 플래그 비활성화 (이전 라운드 플래그 정리)
            expired_count = await self._flag_manager.expire_old_flags()
            if expired_count > 0:
                logger.info("[Round %d] 만료 플래그 %d개 비활성화", round_number, expired_count)

            # 즉시 중단 확인
            if self._halted and self._halt_type == "immediate":
                await self._cancel_round(round_id)
                return

            # Step 3: 플래그 설정 (Plant) — SSH/HTTP로 팀 서비스에 플래그 심기
            plant_result = await self._step3_plant_flags(
                round_id, competition_id, flags
            )
            await self._update_round_timestamp(round_id, "flag_plant_completed_at")
            logger.info(
                "[Round %d] 플래그 plant 완료: 성공=%d, 실패=%d",
                round_number, plant_result["success"], plant_result["failed"],
            )

            # 즉시 중단 확인
            if self._halted and self._halt_type == "immediate":
                await self._cancel_round(round_id)
                return

            # Step 4: SLA 체크
            sla_results = await self._step4_sla_check(
                round_id, round_number, competition_id
            )
            await self._update_round_timestamp(round_id, "sla_check_completed_at")
            logger.info("[Round %d] SLA 체크 완료: %d건", round_number, len(sla_results))

            # Step 5: 플래그 정산
            await self._step5_judge_submissions(round_id, round_number, competition_id)

            # 즉시 중단 확인
            if self._halted and self._halt_type == "immediate":
                await self._cancel_round(round_id)
                return

            # Step 6: 점수 계산
            scores = await self._step6_calculate_scores(round_id, competition_id)
            await self._update_round_timestamp(round_id, "scoring_completed_at")
            logger.info("[Round %d] 점수 계산 완료: %d개 팀", round_number, len(scores))

            # Step 7: 라운드 완료
            await self._step7_complete_round(round_id, round_number, competition_id)
            logger.info("[Round %d] 라운드 완료", round_number)

        except Exception as exc:
            logger.error("라운드 실행 중 오류: %s", exc, exc_info=True)
            if round_id:
                await self._fail_round(round_id, str(exc))

    # ── Step 구현 ──

    async def _step1_start_round(self, competition_id: UUID) -> tuple[UUID, int]:
        """Step 1: 새 라운드를 시작한다."""
        round_id = uuid4()
        async with async_session_factory() as session:
            # 마지막 라운드 번호 조회
            result = await session.execute(
                text("""
                    SELECT COALESCE(MAX(round_number), 0) AS last_round
                    FROM scoring_rounds
                    WHERE competition_id = :comp_id
                """),
                {"comp_id": competition_id},
            )
            last_round = result.scalar() or 0
            round_number = last_round + 1

            # 새 라운드 삽입
            await session.execute(
                text("""
                    INSERT INTO scoring_rounds
                        (id, competition_id, round_number, status, started_at, created_at)
                    VALUES
                        (:id, :comp_id, :round_number, 'running', NOW(), NOW())
                """),
                {
                    "id": round_id,
                    "comp_id": competition_id,
                    "round_number": round_number,
                },
            )
            await session.commit()

        # Redis 이벤트 발행
        await self._event_bus.publish(CH_ROUND_START, {
            "round_number": round_number,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "competition_id": str(competition_id),
        })

        return round_id, round_number

    async def _step2_generate_flags(
        self, round_id: UUID, competition_id: UUID, scoring_interval: int
    ) -> list[dict]:
        """Step 2: 플래그를 생성한다."""
        return await self._flag_manager.generate_flags(
            round_id=round_id,
            competition_id=competition_id,
            scoring_interval_seconds=scoring_interval,
            flag_lifetime_rounds=settings.FLAG_LIFETIME_ROUNDS,
        )

    async def _step3_plant_flags(
        self, round_id: UUID, competition_id: UUID, flags: list[dict]
    ) -> dict:
        """Step 3: 생성된 플래그를 각 팀 서비스에 심는다."""
        return await self._flag_manager.plant_flags(
            round_id=round_id,
            competition_id=competition_id,
            flags=flags,
        )

    async def _step4_sla_check(
        self, round_id: UUID, round_number: int, competition_id: UUID
    ) -> list[dict]:
        """Step 4: SLA 체크를 수행한다."""
        return await self._sla_checker.check_all_services(
            round_id=round_id,
            round_number=round_number,
            competition_id=competition_id,
        )

    async def _step5_judge_submissions(
        self, round_id: UUID, round_number: int, competition_id: UUID
    ) -> None:
        """Step 5: 미판정 플래그 제출 건을 정산한다."""
        async with async_session_factory() as session:
            # 미판정 제출 건 조회 (verdict가 NULL인 것은 없으므로 pending 상태 등을 대비)
            # 기획서: flag_submissions에서 해당 대회의 제출 중 아직 처리 안 된 것
            result = await session.execute(
                text("""
                    SELECT id, submitter_team_id, submitted_flag
                    FROM flag_submissions
                    WHERE competition_id = :comp_id
                      AND flag_id IS NULL
                      AND verdict IN ('correct', 'incorrect', 'expired', 'duplicate', 'own_flag', 'invalid_format')
                    ORDER BY submitted_at ASC
                    LIMIT 0
                """),
                {"comp_id": competition_id},
            )
            # 위 쿼리는 빈 결과 — 실제로는 디스코드 봇이 제출 시 verdict를 비워둘 수 있음
            # 아래에서 실제 미판정 건을 찾아 처리

            pending_result = await session.execute(
                text("""
                    SELECT id, submitter_team_id, submitted_flag
                    FROM flag_submissions
                    WHERE competition_id = :comp_id
                      AND flag_id IS NULL
                    ORDER BY submitted_at ASC
                """),
                {"comp_id": competition_id},
            )
            pending_submissions = pending_result.fetchall()

            if not pending_submissions:
                logger.debug("[Round %d] 미판정 제출 건 없음", round_number)
                return

            judged_count = 0
            for sub in pending_submissions:
                verdict, flag_id = await self._judge_single_submission(
                    session, sub.id, sub.submitter_team_id, sub.submitted_flag
                )
                if verdict:
                    judged_count += 1

                    # correct 판정 시 Redis 이벤트
                    if verdict == "correct" and flag_id:
                        await self._publish_flag_captured(
                            session, sub.submitter_team_id, flag_id, round_number
                        )

            await session.commit()
            if judged_count:
                logger.info("[Round %d] 플래그 정산 %d건 완료", round_number, judged_count)

    async def _judge_single_submission(
        self, session, submission_id: UUID, submitter_team_id: UUID, submitted_flag: str
    ) -> tuple[str | None, UUID | None]:
        """단일 플래그 제출을 검증하고 verdict를 결정한다.

        기획서 5.4절 검증 순서를 정확히 따른다:
        1) 형식 검사 → invalid_format
        2) flags 테이블 존재 여부 → incorrect
        3) 만료 여부 → expired
        4) 자기 팀 플래그 → own_flag
        5) 중복 제출 → duplicate
        6) 모두 통과 → correct
        """
        # 1) 형식 검사
        if not FLAG_PATTERN.match(submitted_flag):
            await self._update_submission_verdict(session, submission_id, "invalid_format", None)
            return "invalid_format", None

        # 2) flags 테이블에서 조회
        flag_result = await session.execute(
            text("""
                SELECT id, team_id, is_active, expires_at, slot_key, slot_label, point_value
                FROM flags
                WHERE flag_value = :flag_value
                LIMIT 1
            """),
            {"flag_value": submitted_flag},
        )
        flag_row = flag_result.fetchone()

        if flag_row is None:
            await self._update_submission_verdict(session, submission_id, "incorrect", None)
            return "incorrect", None

        flag_id = flag_row.id

        # 3) 만료 여부
        if not flag_row.is_active or (
            flag_row.expires_at and flag_row.expires_at <= datetime.now(timezone.utc)
        ):
            await self._update_submission_verdict(
                session,
                submission_id,
                "expired",
                flag_id,
                slot_key=flag_row.slot_key,
                slot_label=flag_row.slot_label,
                points_awarded=flag_row.point_value,
            )
            return "expired", flag_id

        # 4) 자기 팀 플래그
        if flag_row.team_id == submitter_team_id:
            await self._update_submission_verdict(
                session,
                submission_id,
                "own_flag",
                flag_id,
                slot_key=flag_row.slot_key,
                slot_label=flag_row.slot_label,
                points_awarded=flag_row.point_value,
            )
            return "own_flag", flag_id

        # 5) 중복 제출 (같은 팀이 같은 플래그를 이미 correct 으로 제출)
        dup_result = await session.execute(
            text("""
                SELECT COUNT(*) AS cnt
                FROM flag_submissions
                WHERE submitter_team_id = :team_id
                  AND flag_id = :flag_id
                  AND verdict = 'correct'
            """),
            {"team_id": submitter_team_id, "flag_id": flag_id},
        )
        if (dup_result.scalar() or 0) > 0:
            await self._update_submission_verdict(
                session,
                submission_id,
                "duplicate",
                flag_id,
                slot_key=flag_row.slot_key,
                slot_label=flag_row.slot_label,
                points_awarded=flag_row.point_value,
            )
            return "duplicate", flag_id

        # 6) 정답
        await self._update_submission_verdict(
            session,
            submission_id,
            "correct",
            flag_id,
            slot_key=flag_row.slot_key,
            slot_label=flag_row.slot_label,
            points_awarded=flag_row.point_value,
        )
        return "correct", flag_id

    @staticmethod
    async def _update_submission_verdict(
        session,
        submission_id: UUID,
        verdict: str,
        flag_id: UUID | None,
        *,
        slot_key: str | None = None,
        slot_label: str | None = None,
        points_awarded: int | None = None,
    ) -> None:
        """제출 건의 verdict와 flag_id를 업데이트한다."""
        await session.execute(
            text("""
                UPDATE flag_submissions
                SET verdict = :verdict,
                    flag_id = :flag_id,
                    slot_key = COALESCE(:slot_key, slot_key),
                    slot_label = COALESCE(:slot_label, slot_label),
                    points_awarded = COALESCE(:points_awarded, points_awarded)
                WHERE id = :id
            """),
            {
                "verdict": verdict,
                "flag_id": flag_id,
                "slot_key": slot_key,
                "slot_label": slot_label,
                "points_awarded": points_awarded,
                "id": submission_id,
            },
        )

    async def _publish_flag_captured(
        self, session, attacker_team_id: UUID, flag_id: UUID, round_number: int
    ) -> None:
        """correct 판정 시 flag:captured 이벤트를 발행한다."""
        from .events import CH_FLAG_CAPTURED

        result = await session.execute(
            text("""
                SELECT
                    f.team_id AS defender_team_id,
                    td.name AS defender_team_name,
                    ta.name AS attacker_team_name,
                    vs.name AS service_name
                FROM flags f
                JOIN teams td ON f.team_id = td.id
                JOIN teams ta ON ta.id = :attacker_id
                JOIN vuln_services vs ON f.service_id = vs.id
                WHERE f.id = :flag_id
            """),
            {"flag_id": flag_id, "attacker_id": attacker_team_id},
        )
        row = result.fetchone()
        if row:
            await self._event_bus.publish(CH_FLAG_CAPTURED, {
                "attacker_team_id": str(attacker_team_id),
                "attacker_team_name": row.attacker_team_name,
                "defender_team_id": str(row.defender_team_id),
                "defender_team_name": row.defender_team_name,
                "service": row.service_name,
                "round_number": round_number,
            })

    async def _step6_calculate_scores(
        self, round_id: UUID, competition_id: UUID
    ) -> list[dict]:
        """Step 6: 점수를 계산한다."""
        return await self._score_calculator.calculate_round_scores(
            round_id=round_id,
            competition_id=competition_id,
        )

    async def _step7_complete_round(
        self, round_id: UUID, round_number: int, competition_id: UUID
    ) -> None:
        """Step 7: 라운드를 완료하고 이벤트를 발행한다."""
        # 라운드 상태 변경
        async with async_session_factory() as session:
            await session.execute(
                text("""
                    UPDATE scoring_rounds
                    SET status = 'completed', completed_at = NOW()
                    WHERE id = :round_id
                """),
                {"round_id": round_id},
            )
            await session.commit()

        # 누적 순위 계산 (이벤트 페이로드용)
        rankings = await self._score_calculator.compute_cumulative_rankings(competition_id)
        top3 = [
            {"rank": r["rank"], "team": r["team_name"], "score": float(r["cumulative_score"])}
            for r in rankings[:3]
        ]

        # Redis 이벤트 발행
        await self._event_bus.publish(CH_ROUND_COMPLETE, {
            "round_number": round_number,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "top3": top3,
            "total_teams": len(rankings),
        })

    # ── 라운드 상태 변경 헬퍼 ──

    async def _cancel_round(self, round_id: UUID) -> None:
        """즉시 중단: 현재 라운드를 cancelled 로 표시한다."""
        async with async_session_factory() as session:
            await session.execute(
                text("""
                    UPDATE scoring_rounds
                    SET status = 'cancelled', completed_at = NOW()
                    WHERE id = :round_id
                """),
                {"round_id": round_id},
            )
            await session.commit()
        logger.warning("라운드 즉시 취소: %s", round_id)

    async def _fail_round(self, round_id: UUID, error_detail: str) -> None:
        """라운드를 실패 상태로 표시한다."""
        async with async_session_factory() as session:
            await session.execute(
                text("""
                    UPDATE scoring_rounds
                    SET status = 'failed', error_detail = :error, completed_at = NOW()
                    WHERE id = :round_id
                """),
                {"round_id": round_id, "error": error_detail},
            )
            await session.commit()
        logger.error("라운드 실패 기록: %s — %s", round_id, error_detail)

    @staticmethod
    async def _update_round_timestamp(round_id: UUID, column: str) -> None:
        """라운드의 특정 타임스탬프 컬럼을 현재 시각으로 갱신한다."""
        # 허용된 컬럼만 업데이트 (SQL Injection 방지)
        allowed = {"flag_plant_completed_at", "sla_check_completed_at", "scoring_completed_at"}
        if column not in allowed:
            raise ValueError(f"허용되지 않은 컬럼: {column}")

        async with async_session_factory() as session:
            await session.execute(
                text(f"UPDATE scoring_rounds SET {column} = NOW() WHERE id = :round_id"),
                {"round_id": round_id},
            )
            await session.commit()

    # ── 대회 상태 조회 ──

    async def _get_running_competition(self) -> dict | None:
        """status IN ('running', 'paused')인 대회를 조회한다. 없으면 None.

        paused 대회도 조회 대상에 포함 — 자동 공개 체크 시 paused면 건너뛰고
        라운드 실행은 안 하도록 상위 루프에서 분기한다.

        DB 테이블 미생성(ops-backend보다 먼저 시작) 등 예외 시에도 None 반환하여
        메인 루프가 5초 후 재시도하도록 한다.
        """
        try:
            async with async_session_factory() as session:
                result = await session.execute(
                    text("""
                        SELECT
                            id,
                            status,
                            actual_start_at,
                            scheduled_start_at,
                            scheduled_end_at,
                            scoring_round_interval_seconds AS scoring_interval
                        FROM competitions
                        WHERE status IN ('running', 'paused')
                        LIMIT 1
                    """)
                )
                row = result.fetchone()
                if row is None:
                    return None
                return {
                    "id": row.id,
                    "status": row.status,
                    "actual_start_at": row.actual_start_at,
                    "scheduled_start_at": row.scheduled_start_at,
                    "scheduled_end_at": row.scheduled_end_at,
                    "scoring_interval": row.scoring_interval,
                }
        except Exception as exc:
            logger.warning("대회 상태 조회 실패 (DB 미준비 또는 연결 오류): %s", exc)
            return None

    def _get_scoring_interval(self, db_interval: int) -> int:
        """실제 적용할 라운드 간격을 결정한다.

        환경변수 오버라이드 > DB 설정 순서.
        """
        if self._interval_override is not None:
            return self._interval_override
        return db_interval

    @staticmethod
    def _coerce_utc(value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def _is_competition_window_open(self, comp: dict) -> bool:
        now = datetime.now(timezone.utc)
        scheduled_start_at = self._coerce_utc(comp.get("scheduled_start_at"))
        scheduled_end_at = self._coerce_utc(comp.get("scheduled_end_at"))

        if scheduled_start_at and now < scheduled_start_at:
            return False
        if scheduled_end_at and now >= scheduled_end_at:
            return False
        return True

    # ── Redis 이벤트 핸들러 ──

    def _register_event_handlers(self) -> None:
        """Redis 구독 채널별 핸들러를 등록한다."""
        self._event_bus.on(CH_EMERGENCY_HALT, self._on_emergency_halt)
        self._event_bus.on(CH_EMERGENCY_RESUME, self._on_emergency_resume)
        self._event_bus.on(CH_CONFIG_INTERVAL, self._on_config_interval)
        self._event_bus.on(CH_COMPETITION_START, self._on_competition_start)
        self._event_bus.on(CH_COMPETITION_END, self._on_competition_end)

    async def _on_emergency_halt(self, _channel: str, data: dict) -> None:
        """비상 중단 이벤트 처리."""
        halt_type = data.get("type", "graceful")
        reason = data.get("reason", "")
        logger.warning("비상 중단 수신: type=%s, reason=%s", halt_type, reason)
        await self.halt(halt_type)

    async def _on_emergency_resume(self, _channel: str, data: dict) -> None:
        """비상 재개 이벤트 처리."""
        resumed_by = data.get("resumed_by", "unknown")
        logger.info("비상 재개 수신: resumed_by=%s", resumed_by)
        await self.resume()

    async def _on_config_interval(self, _channel: str, data: dict) -> None:
        """라운드 간격 변경 이벤트 처리."""
        seconds = data.get("seconds")
        if seconds and isinstance(seconds, int) and seconds > 0:
            self._interval_override = seconds
            logger.info("라운드 간격 변경: %d초", seconds)

    async def _on_competition_start(self, _channel: str, data: dict) -> None:
        """대회 시작 이벤트 처리."""
        comp_id = data.get("competition_id")
        logger.info("대회 시작 이벤트 수신: competition_id=%s", comp_id)

    async def _on_competition_end(self, _channel: str, data: dict) -> None:
        """대회 종료 이벤트 처리."""
        comp_id = data.get("competition_id")
        logger.info("대회 종료 이벤트 수신: competition_id=%s — 채점 중지", comp_id)
        self._running = False
        self._shutdown_event.set()

    # ── Graceful Shutdown ──

    def _setup_signal_handlers(self) -> None:
        """SIGTERM/SIGINT 시그널 핸들러를 등록한다."""
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._handle_shutdown_signal)
            except NotImplementedError:
                # Windows 환경에서는 add_signal_handler 미지원
                signal.signal(sig, lambda s, f: self._handle_shutdown_signal())

    def _handle_shutdown_signal(self) -> None:
        """종료 시그널을 수신하여 셧다운 이벤트를 설정한다."""
        logger.info("종료 시그널 수신 — graceful shutdown 시작")
        self._running = False
        self._shutdown_event.set()

    async def _cleanup(self) -> None:
        """종료 시 리소스를 정리한다."""
        logger.info("채점 엔진 종료 중...")
        await self._event_bus.disconnect()
        await dispose_engine()
        logger.info("채점 엔진 종료 완료")
