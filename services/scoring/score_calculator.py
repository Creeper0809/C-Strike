"""점수 계산 모듈.

기획서 4절의 공식을 정확히 구현한다:
- 공격 점수(A): 해당 라운드에서 correct 판정받은 고유 플래그 수
- 방어 점수(D): 서비스별 (N-1 - stolen_count) / (N-1) 의 평균
- SLA 점수: 성공한 SLA 체크 수 / 전체 SLA 체크 수
- 최종: (A + effective_defense * defense_weight) * SLA
"""

from __future__ import annotations

import logging
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import text

from .config import settings
from .database import async_session_factory

logger = logging.getLogger("scoring.score_calculator")


class ScoreCalculator:
    """라운드별 팀 점수 계산 및 순위 산출을 담당한다."""

    async def calculate_round_scores(
        self,
        round_id: UUID,
        competition_id: UUID,
        defense_weight: float | None = None,
        sla_penalty_threshold: float | None = None,
    ) -> list[dict]:
        """한 라운드의 모든 팀 점수를 계산하고 team_scores에 기록한다.

        Args:
            round_id: 현재 라운드 ID
            competition_id: 대회 ID
            defense_weight: 방어 점수 가중치 (None이면 설정 기본값)
            sla_penalty_threshold: SLA 페널티 임계값 (None이면 설정 기본값)

        Returns:
            팀별 점수 목록 [{team_id, attack, defense, sla, total, rank}, ...]
        """
        d_weight = defense_weight if defense_weight is not None else settings.DEFENSE_WEIGHT
        sla_threshold = (
            sla_penalty_threshold
            if sla_penalty_threshold is not None
            else settings.SLA_PENALTY_THRESHOLD
        )

        async with async_session_factory() as session:
            # 활성 팀 목록
            teams_result = await session.execute(
                text("""
                    SELECT id, name FROM teams
                    WHERE competition_id = :comp_id
                      AND status IN ('active', 'approved')
                """),
                {"comp_id": competition_id},
            )
            teams = teams_result.fetchall()
            if not teams:
                logger.warning("점수 계산 대상 팀 없음 (competition_id=%s)", competition_id)
                return []

            total_teams = len(teams)

            # 활성 서비스 수
            services_result = await session.execute(
                text("""
                    SELECT COUNT(*) AS cnt FROM vuln_services
                    WHERE (competition_id = :comp_id OR competition_id IS NULL)
                      AND status = 'active'
                """),
                {"comp_id": competition_id},
            )
            total_services = services_result.scalar() or 0

            scores: list[dict] = []
            for team in teams:
                team_id = team.id

                # ── 공격 점수 ──
                attack_score = await self._calc_attack_score(session, team_id, round_id)

                # ── 방어 점수 ──
                defense_score = await self._calc_defense_score(
                    session, team_id, round_id, total_teams, total_services
                )

                # ── SLA 점수 ──
                sla_score = await self._calc_sla_score(session, team_id, round_id)

                # ── 최종 점수 ──
                # SLA 페널티: SLA < threshold 이면 defense = 0
                effective_defense = defense_score if sla_score >= Decimal(str(sla_threshold)) else Decimal("0")
                total_score = (
                    (attack_score + effective_defense * Decimal(str(d_weight))) * sla_score
                )
                # 소수점 2자리로 반올림
                total_score = total_score.quantize(Decimal("0.01"))

                scores.append({
                    "id": uuid4(),
                    "round_id": round_id,
                    "team_id": team_id,
                    "team_name": team.name,
                    "attack_score": attack_score,
                    "defense_score": defense_score,
                    "sla_score": sla_score,
                    "bonus_score": Decimal("0"),
                    "total_score": total_score,
                })

            # ── 순위 계산 (라운드 점수 내림차순) ──
            scores.sort(key=lambda s: s["total_score"], reverse=True)
            for rank, score_entry in enumerate(scores, start=1):
                score_entry["rank"] = rank

            # ── team_scores 일괄 삽입 ──
            if scores:
                await session.execute(
                    text("""
                        INSERT INTO team_scores
                            (id, round_id, team_id, attack_score, defense_score,
                             sla_score, bonus_score, total_score, rank, created_at)
                        VALUES
                            (:id, :round_id, :team_id, :attack_score, :defense_score,
                             :sla_score, :bonus_score, :total_score, :rank, NOW())
                    """),
                    [
                        {
                            "id": s["id"],
                            "round_id": s["round_id"],
                            "team_id": s["team_id"],
                            "attack_score": s["attack_score"],
                            "defense_score": s["defense_score"],
                            "sla_score": s["sla_score"],
                            "bonus_score": s["bonus_score"],
                            "total_score": s["total_score"],
                            "rank": s["rank"],
                        }
                        for s in scores
                    ],
                )
                await session.commit()
                logger.info("라운드 점수 기록 완료: %d개 팀", len(scores))

            return scores

    async def compute_cumulative_rankings(
        self, competition_id: UUID
    ) -> list[dict]:
        """누적 점수 기반 전체 순위를 계산한다.

        동점 시 최근 라운드 점수가 높은 팀이 우선한다.

        Returns:
            [{team_id, team_name, cumulative_score, rank}, ...]
        """
        async with async_session_factory() as session:
            result = await session.execute(
                text("""
                    WITH cumulative AS (
                        SELECT
                            ts.team_id,
                            t.name AS team_name,
                            SUM(ts.total_score) AS cumulative_score,
                            MAX(sr.round_number) AS last_round
                        FROM team_scores ts
                        JOIN teams t ON ts.team_id = t.id
                        JOIN scoring_rounds sr ON ts.round_id = sr.id
                        WHERE t.competition_id = :comp_id
                          AND sr.status = 'completed'
                        GROUP BY ts.team_id, t.name
                    ),
                    last_round_score AS (
                        SELECT ts.team_id, ts.total_score AS latest_score
                        FROM team_scores ts
                        JOIN scoring_rounds sr ON ts.round_id = sr.id
                        WHERE sr.competition_id = :comp_id
                          AND sr.round_number = (
                              SELECT MAX(round_number)
                              FROM scoring_rounds
                              WHERE competition_id = :comp_id AND status = 'completed'
                          )
                    )
                    SELECT
                        c.team_id,
                        c.team_name,
                        c.cumulative_score,
                        COALESCE(l.latest_score, 0) AS latest_score
                    FROM cumulative c
                    LEFT JOIN last_round_score l ON c.team_id = l.team_id
                    ORDER BY c.cumulative_score DESC, l.latest_score DESC
                """),
                {"comp_id": competition_id},
            )
            rows = result.fetchall()

        rankings = []
        for rank, row in enumerate(rows, start=1):
            rankings.append({
                "team_id": row.team_id,
                "team_name": row.team_name,
                "cumulative_score": row.cumulative_score,
                "rank": rank,
            })
        return rankings

    # ── 개별 점수 계산 헬퍼 ──

    @staticmethod
    async def _calc_attack_score(session, team_id: UUID, round_id: UUID) -> Decimal:
        """공격 점수: 해당 라운드 창에서 탈취한 고유 플래그의 점수 합.

        기존 구현은 ``flags.round_id == 현재 round_id`` 인 플래그만 세어,
        라운드 사이 공백 구간에 제출된 정답 플래그가 다음 라운드 점수에
        반영되지 않는 문제가 있었다.

        이제는 현재 라운드의 scoring window 를

        - 시작: 직전 completed 라운드의 ``completed_at`` (없으면 현재 라운드 ``started_at``)
        - 종료: 현재 라운드 ``completed_at`` (없으면 ``NOW()``)

        로 정의하고, 그 시간창 안에 들어온 correct 제출을 집계한다.
        """
        window_result = await session.execute(
            text("""
                WITH current_round AS (
                    SELECT competition_id, round_number, started_at, completed_at
                    FROM scoring_rounds
                    WHERE id = :round_id
                ),
                previous_round AS (
                    SELECT sr.completed_at
                    FROM scoring_rounds sr
                    JOIN current_round cr
                      ON sr.competition_id = cr.competition_id
                    WHERE sr.status = 'completed'
                      AND sr.round_number = cr.round_number - 1
                    LIMIT 1
                )
                SELECT
                    COALESCE(
                        (SELECT completed_at FROM previous_round),
                        (SELECT started_at FROM current_round),
                        NOW()
                    ) AS window_start,
                    COALESCE(
                        (SELECT completed_at FROM current_round),
                        NOW()
                    ) AS window_end
            """),
            {"round_id": round_id},
        )
        window = window_result.fetchone()
        if window is None:
            return Decimal("0")

        result = await session.execute(
            text("""
                SELECT COALESCE(SUM(captured.points), 0) AS attack_score
                FROM (
                    SELECT DISTINCT fs.flag_id, COALESCE(fs.points_awarded, f.point_value, 0) AS points
                    FROM flag_submissions fs
                    JOIN flags f ON fs.flag_id = f.id
                    WHERE fs.submitter_team_id = :team_id
                      AND fs.verdict = 'correct'
                      AND fs.submitted_at > :window_start
                      AND fs.submitted_at <= :window_end
                      AND f.team_id != :team_id
                ) captured
            """),
            {
                "team_id": team_id,
                "window_start": window.window_start,
                "window_end": window.window_end,
            },
        )
        val = result.scalar()
        return Decimal(str(val)) if val else Decimal("0")

    @staticmethod
    async def _calc_defense_score(
        session, team_id: UUID, round_id: UUID, total_teams: int, total_services: int
    ) -> Decimal:
        """방어 점수: 현재 라운드의 플래그 슬롯별 (N-1 - stolen_count) / (N-1) 의 평균.

        다중 플래그 슬롯이 있으므로 서비스 단위가 아니라 실제 플래그 단위로 계산한다.
        """
        if total_teams <= 1:
            return Decimal("1")

        n_minus_1 = Decimal(str(total_teams - 1))

        flag_rows = await session.execute(
            text("""
                SELECT id
                FROM flags
                WHERE team_id = :team_id
                  AND round_id = :round_id
            """),
            {"team_id": team_id, "round_id": round_id},
        )
        flag_ids = [row.id for row in flag_rows.fetchall()]
        if not flag_ids:
            return Decimal("1")

        # 플래그별 탈취한 고유 팀 수
        result = await session.execute(
            text("""
                SELECT f.id AS flag_id, COUNT(DISTINCT fs.submitter_team_id) AS stolen_count
                FROM flag_submissions fs
                JOIN flags f ON fs.flag_id = f.id
                WHERE f.team_id = :team_id
                  AND f.round_id = :round_id
                  AND fs.verdict = 'correct'
                  AND fs.submitter_team_id != :team_id
                GROUP BY f.id
            """),
            {"team_id": team_id, "round_id": round_id},
        )
        stolen_map: dict[UUID, int] = {}
        for row in result.fetchall():
            stolen_map[row.flag_id] = row.stolen_count

        total_defense = Decimal("0")
        for flag_id in flag_ids:
            stolen_count = Decimal(str(stolen_map.get(flag_id, 0)))
            d_s = max(Decimal("0"), (n_minus_1 - stolen_count) / n_minus_1)
            total_defense += d_s

        defense_score = total_defense / Decimal(str(len(flag_ids)))
        return defense_score.quantize(Decimal("0.0001"))

    @staticmethod
    async def _calc_sla_score(session, team_id: UUID, round_id: UUID) -> Decimal:
        """SLA 점수: 성공한 SLA 체크 수 / 전체 SLA 체크 수."""
        result = await session.execute(
            text("""
                SELECT
                    COUNT(*) FILTER (WHERE is_up = true) AS up_count,
                    COUNT(*) AS total_count
                FROM sla_checks
                WHERE team_id = :team_id AND round_id = :round_id
            """),
            {"team_id": team_id, "round_id": round_id},
        )
        row = result.fetchone()
        if not row or row.total_count == 0:
            return Decimal("1")  # SLA 체크 없으면 100%로 간주

        sla = Decimal(str(row.up_count)) / Decimal(str(row.total_count))
        return sla.quantize(Decimal("0.0001"))
