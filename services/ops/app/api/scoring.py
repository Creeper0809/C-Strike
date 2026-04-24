"""채점 모니터링 API — 라운드/에러/공격 현황 조회 전용.

pause/resume 기능은 /api/emergency/halt-scoring, /api/emergency/resume 로 통합되어
emergency_actions 테이블 + Redis + Discord + audit log 를 일괄 처리한다.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db

router = APIRouter(tags=["채점"])


# ── GET /scoring/status ──────────────────────────────────────

@router.get("/status")
async def get_scoring_status(db: AsyncSession = Depends(get_db)):
    """채점 시스템 현재 상태를 조회한다."""
    # 현재 대회 상태 확인
    comp_result = await db.execute(
        text("""
            SELECT id, status
            FROM cstrike.competitions
            WHERE status IN ('running', 'paused')
            LIMIT 1
        """)
    )
    comp = comp_result.fetchone()
    is_running = comp is not None and comp.status == "running"

    # 비상 중단 상태 확인
    halt_result = await db.execute(
        text("""
            SELECT COUNT(*) AS cnt
            FROM cstrike.emergency_actions
            WHERE reverted_at IS NULL
              AND action_type IN ('halt_all', 'halt_scoring')
        """)
    )
    is_halted = (halt_result.scalar() or 0) > 0
    if is_halted:
        is_running = False

    if comp is None:
        return {
            "is_running": False,
            "current_round": 0,
            "total_rounds": 0,
            "last_round_at": None,
            "success_rate": 0.0,
            "teams_checked": 0,
            "services_checked": 0,
        }

    competition_id = comp.id

    # 라운드 통계
    round_result = await db.execute(
        text("""
            SELECT
                COALESCE(MAX(round_number), 0) AS current_round,
                COUNT(*) AS total_rounds,
                MAX(completed_at) AS last_round_at
            FROM cstrike.scoring_rounds
            WHERE competition_id = :comp_id
        """),
        {"comp_id": competition_id},
    )
    round_row = round_result.fetchone()

    # 최근 완료 라운드의 SLA 통계
    latest_round_result = await db.execute(
        text("""
            SELECT id FROM cstrike.scoring_rounds
            WHERE competition_id = :comp_id AND status = 'completed'
            ORDER BY round_number DESC
            LIMIT 1
        """),
        {"comp_id": competition_id},
    )
    latest_round = latest_round_result.fetchone()

    success_rate = 0.0
    teams_checked = 0
    services_checked = 0

    if latest_round:
        sla_result = await db.execute(
            text("""
                SELECT
                    COUNT(*) AS total_checks,
                    COUNT(*) FILTER (WHERE is_up = true) AS up_count,
                    COUNT(DISTINCT team_id) AS teams,
                    COUNT(DISTINCT service_id) AS services
                FROM cstrike.sla_checks
                WHERE round_id = :round_id
            """),
            {"round_id": latest_round.id},
        )
        sla_row = sla_result.fetchone()
        if sla_row and sla_row.total_checks > 0:
            success_rate = round(sla_row.up_count / sla_row.total_checks * 100, 1)
            teams_checked = sla_row.teams
            services_checked = sla_row.services

    return {
        "is_running": is_running,
        "current_round": round_row.current_round if round_row else 0,
        "total_rounds": round_row.total_rounds if round_row else 0,
        "last_round_at": round_row.last_round_at.isoformat() if round_row and round_row.last_round_at else None,
        "success_rate": success_rate,
        "teams_checked": teams_checked,
        "services_checked": services_checked,
    }


# ── GET /scoring/rounds ──────────────────────────────────────

@router.get("/rounds")
async def get_scoring_rounds(
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """채점 라운드 목록을 조회한다."""
    result = await db.execute(
        text("""
            SELECT
                sr.id AS round_id,
                sr.round_number,
                sr.status,
                sr.started_at,
                sr.completed_at,
                COUNT(sc.*) FILTER (WHERE sc.is_up = true) AS success_count,
                COUNT(sc.*) FILTER (WHERE sc.is_up = false) AS fail_count,
                COUNT(sc.*) FILTER (WHERE sc.error_message IS NOT NULL AND sc.is_up = false) AS error_count
            FROM cstrike.scoring_rounds sr
            LEFT JOIN cstrike.sla_checks sc ON sr.id = sc.round_id
            GROUP BY sr.id, sr.round_number, sr.status, sr.started_at, sr.completed_at
            ORDER BY sr.round_number DESC
            LIMIT :limit
        """),
        {"limit": limit},
    )
    rows = result.fetchall()

    return [
        {
            "round_number": r.round_number,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "success_count": r.success_count,
            "fail_count": r.fail_count,
            "error_count": r.error_count,
        }
        for r in rows
    ]


# ── GET /scoring/errors ──────────────────────────────────────

@router.get("/errors")
async def get_scoring_errors(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """채점 오류 목록을 조회한다 (SLA 실패 기록)."""
    offset = (page - 1) * limit

    result = await db.execute(
        text("""
            SELECT
                sc.id,
                sr.round_number,
                sc.team_id,
                t.name AS team_name,
                sc.service_id,
                vs.name AS service_name,
                sc.check_type AS error_type,
                sc.error_message,
                sc.checked_at AS occurred_at
            FROM cstrike.sla_checks sc
            JOIN cstrike.scoring_rounds sr ON sc.round_id = sr.id
            JOIN cstrike.teams t ON sc.team_id = t.id
            JOIN cstrike.vuln_services vs ON sc.service_id = vs.id
            WHERE sc.is_up = false
            ORDER BY sc.checked_at DESC
            OFFSET :offset
            LIMIT :limit
        """),
        {"offset": offset, "limit": limit},
    )
    rows = result.fetchall()

    return {
        "items": [
            {
                "id": str(r.id),
                "round": r.round_number,
                "team_id": str(r.team_id),
                "team_name": r.team_name,
                "service_id": str(r.service_id),
                "service_name": r.service_name,
                "error_type": r.error_type or "sla_fail",
                "error_message": r.error_message or "SLA 체크 실패",
                "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
            }
            for r in rows
        ],
        "total": len(rows),
    }


# ── GET /scoring/attacks ─────────────────────────────────────

@router.get("/attacks")
async def get_scoring_attacks(
    team_id: str | None = Query(None),
    service_id: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """플래그 제출(공격) 로그를 조회한다."""
    conditions = ["1=1"]
    params: dict = {}

    if team_id:
        conditions.append("fs.submitter_team_id = :team_id")
        params["team_id"] = team_id
    if service_id:
        conditions.append("f.service_id = :service_id")
        params["service_id"] = service_id

    where_clause = " AND ".join(conditions)

    result = await db.execute(
        text(f"""
            SELECT
                fs.id,
                fs.submitter_team_id,
                ta.name AS attacker_name,
                f.team_id AS defender_team_id,
                td.name AS defender_name,
                vs.name AS service_name,
                fs.verdict,
                fs.submitted_at
            FROM cstrike.flag_submissions fs
            JOIN cstrike.flags f ON fs.flag_id = f.id
            JOIN cstrike.teams ta ON fs.submitter_team_id = ta.id
            JOIN cstrike.teams td ON f.team_id = td.id
            JOIN cstrike.vuln_services vs ON f.service_id = vs.id
            WHERE {where_clause}
            ORDER BY fs.submitted_at DESC
            LIMIT 100
        """),
        params,
    )
    rows = result.fetchall()

    return [
        {
            "id": str(r.id),
            "attacker_team_id": str(r.submitter_team_id),
            "attacker_name": r.attacker_name,
            "defender_team_id": str(r.defender_team_id),
            "defender_name": r.defender_name,
            "service_name": r.service_name,
            "verdict": r.verdict,
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
        }
        for r in rows
    ]


# 채점 pause/resume 엔드포인트는 /api/emergency/halt-scoring, /api/emergency/resume 로 통합됨.
# (emergency_actions 테이블 INSERT + Redis publish + Discord 알림 + audit log 완비)
