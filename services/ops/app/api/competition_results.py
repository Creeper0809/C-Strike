"""대회 결과 리포트 / 타임라인 / 데이터 내보내기 API 라우터."""

import csv
import io
import json
import zipfile
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator, require_role
from app.models.audit import OpsAuditLog
from app.models.competition import Competition
from app.models.flag import Flag, FlagSubmission
from app.models.operator import Operator
from app.models.scoring_round import ScoringRound
from app.models.sla_check import SlaCheck
from app.models.team import Team
from app.models.team_score import TeamScore
from app.models.vuln_service import VulnService
from app.schemas.competition_results import (
    CompetitionResultsResponse,
    ServiceStat,
    TeamRanking,
    TimelineEvent,
    TimelineResponse,
)
from app.utils.audit import record_audit

router = APIRouter(tags=["대회 결과"])

FINISHED_STATUSES = {"finished", "archived"}


# -- 헬퍼 함수 --

async def _get_competition_or_404(db: AsyncSession, competition_id: UUID) -> Competition:
    """대회를 조회하거나 404를 반환한다."""
    result = await db.execute(
        select(Competition).where(Competition.id == competition_id)
    )
    competition = result.scalar_one_or_none()
    if competition is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="대회를 찾을 수 없습니다.",
        )
    return competition


def _require_finished(comp: Competition) -> None:
    """대회가 finished/archived 상태가 아니면 400 에러를 발생시킨다."""
    if comp.status not in FINISHED_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"대회가 아직 종료되지 않았습니다. (현재 상태: {comp.status})",
        )


def _compute_duration_hours(comp: Competition) -> float:
    """대회 실제 진행 시간(시간 단위)을 계산한다."""
    if comp.actual_start_at and comp.actual_end_at:
        delta = comp.actual_end_at - comp.actual_start_at
        return round(delta.total_seconds() / 3600, 2)
    return 0.0


# -- 1) GET /results --

@router.get("/results")
async def get_competition_results(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> CompetitionResultsResponse:
    """대회 결과 리포트를 조회한다. finished/archived 상태에서만 가능."""
    comp = await _get_competition_or_404(db, competition_id)
    _require_finished(comp)

    # 총 라운드 수
    total_rounds = (await db.execute(
        select(func.count()).select_from(ScoringRound).where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
        )
    )).scalar_one()

    # 참가 팀 수 (approved 이상)
    total_teams = (await db.execute(
        select(func.count()).select_from(Team).where(
            Team.competition_id == competition_id,
            Team.status.in_(["approved", "active", "disqualified", "withdrawn"]),
        )
    )).scalar_one()

    # 플래그 제출 통계
    total_flag_submissions = (await db.execute(
        select(func.count()).select_from(FlagSubmission).where(
            FlagSubmission.competition_id == competition_id,
        )
    )).scalar_one()

    total_correct_flags = (await db.execute(
        select(func.count()).select_from(FlagSubmission).where(
            FlagSubmission.competition_id == competition_id,
            FlagSubmission.verdict == "correct",
        )
    )).scalar_one()

    # -- 팀별 순위 집계 --
    # team_scores에서 팀별 합산 + 팀 이름 조인
    ranking_query = (
        select(
            Team.id.label("team_id"),
            Team.name.label("team_name"),
            func.coalesce(func.sum(TeamScore.attack_score), 0).label("attack_score"),
            func.coalesce(func.sum(TeamScore.defense_score), 0).label("defense_score"),
            func.coalesce(func.sum(TeamScore.total_score), 0).label("total_score"),
            func.coalesce(func.avg(TeamScore.sla_score), 0).label("avg_sla"),
        )
        .join(TeamScore, TeamScore.team_id == Team.id, isouter=True)
        .where(Team.competition_id == competition_id)
        .group_by(Team.id, Team.name)
        .order_by(func.coalesce(func.sum(TeamScore.total_score), 0).desc())
    )
    ranking_rows = (await db.execute(ranking_query)).all()

    # 팀별 플래그 탈취/피탈 수
    flags_captured_map: dict[UUID, int] = {}
    captured_query = (
        select(
            FlagSubmission.submitter_team_id,
            func.count().label("cnt"),
        )
        .where(
            FlagSubmission.competition_id == competition_id,
            FlagSubmission.verdict == "correct",
        )
        .group_by(FlagSubmission.submitter_team_id)
    )
    for row in (await db.execute(captured_query)).all():
        flags_captured_map[row.submitter_team_id] = row.cnt

    flags_lost_map: dict[UUID, int] = {}
    lost_query = (
        select(
            FlagSubmission.target_team_id,
            func.count().label("cnt"),
        )
        .where(
            FlagSubmission.competition_id == competition_id,
            FlagSubmission.verdict == "correct",
            FlagSubmission.target_team_id.isnot(None),
        )
        .group_by(FlagSubmission.target_team_id)
    )
    for row in (await db.execute(lost_query)).all():
        flags_lost_map[row.target_team_id] = row.cnt

    rankings: list[TeamRanking] = []
    for idx, row in enumerate(ranking_rows, start=1):
        rankings.append(TeamRanking(
            rank=idx,
            team_name=row.team_name,
            team_id=row.team_id,
            total_score=float(row.total_score),
            attack_score=float(row.attack_score),
            defense_score=float(row.defense_score),
            sla_percentage=round(float(row.avg_sla) * 100, 2),
            flags_captured=flags_captured_map.get(row.team_id, 0),
            flags_lost=flags_lost_map.get(row.team_id, 0),
        ))

    # -- 서비스별 통계 --
    service_stats: list[ServiceStat] = []
    svc_query = (
        select(
            VulnService.id.label("service_id"),
            VulnService.name.label("service_name"),
            func.count(FlagSubmission.id).label("total_captured"),
        )
        .join(FlagSubmission, FlagSubmission.service_id == VulnService.id, isouter=True)
        .where(
            VulnService.competition_id == competition_id,
            (FlagSubmission.verdict == "correct") | (FlagSubmission.id.is_(None)),
        )
        .group_by(VulnService.id, VulnService.name)
    )
    svc_rows = (await db.execute(svc_query)).all()

    for svc_row in svc_rows:
        # 서비스별 평균 SLA
        avg_sla_result = (await db.execute(
            select(func.avg(case((SlaCheck.is_up, 1), else_=0)))
            .where(SlaCheck.service_id == svc_row.service_id)
        )).scalar_one()
        avg_sla = round(float(avg_sla_result or 0) * 100, 2)

        # 가장 많이 공격받은 팀 (해당 서비스에서 타겟으로 가장 많이 지목된 팀)
        most_attacked_query = (
            select(Team.name, func.count().label("cnt"))
            .join(FlagSubmission, FlagSubmission.target_team_id == Team.id)
            .where(
                FlagSubmission.competition_id == competition_id,
                FlagSubmission.service_id == svc_row.service_id,
                FlagSubmission.verdict == "correct",
            )
            .group_by(Team.name)
            .order_by(func.count().desc())
            .limit(1)
        )
        most_attacked_row = (await db.execute(most_attacked_query)).first()
        most_attacked_team = most_attacked_row.name if most_attacked_row else None

        service_stats.append(ServiceStat(
            service_name=svc_row.service_name,
            service_id=svc_row.service_id,
            total_flags_captured=svc_row.total_captured,
            average_sla=avg_sla,
            most_attacked_team=most_attacked_team,
        ))

    return CompetitionResultsResponse(
        competition_id=comp.id,
        competition_name=comp.name,
        status=comp.status,
        duration_hours=_compute_duration_hours(comp),
        total_rounds=total_rounds,
        total_teams=total_teams,
        total_flag_submissions=total_flag_submissions,
        total_correct_flags=total_correct_flags,
        rankings=rankings,
        service_stats=service_stats,
    )


# -- 2) GET /timeline --

@router.get("/timeline")
async def get_competition_timeline(
    competition_id: UUID,
    from_round: int | None = Query(None, ge=1, description="시작 라운드 번호"),
    to_round: int | None = Query(None, ge=1, description="종료 라운드 번호"),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> TimelineResponse:
    """대회 타임라인 리플레이 데이터를 조회한다."""
    comp = await _get_competition_or_404(db, competition_id)

    if from_round is not None and to_round is not None and from_round > to_round:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="from_round은 to_round보다 클 수 없습니다.",
        )

    # 총 라운드 수
    total_rounds = (await db.execute(
        select(func.max(ScoringRound.round_number)).where(
            ScoringRound.competition_id == competition_id,
        )
    )).scalar_one() or 0

    events: list[TimelineEvent] = []

    # 1) 대회 시작 이벤트
    if comp.actual_start_at:
        events.append(TimelineEvent(
            timestamp=comp.actual_start_at,
            type="competition_started",
            details={},
        ))

    # 2) 라운드 완료 이벤트 — 라운드 범위 필터 적용
    round_query = (
        select(ScoringRound)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
        )
    )
    if from_round is not None:
        round_query = round_query.where(ScoringRound.round_number >= from_round)
    if to_round is not None:
        round_query = round_query.where(ScoringRound.round_number <= to_round)
    round_query = round_query.order_by(ScoringRound.round_number)

    completed_rounds = (await db.execute(round_query)).scalars().all()

    # 라운드별 1등 팀을 미리 조회하기 위한 round_id 수집
    round_id_number_map: dict[UUID, int] = {}
    for rnd in completed_rounds:
        round_id_number_map[rnd.id] = rnd.round_number

    # 라운드별 1위 팀 조회
    top_team_map: dict[UUID, str] = {}
    if round_id_number_map:
        round_ids = list(round_id_number_map.keys())
        top_query = (
            select(TeamScore.round_id, Team.name)
            .join(Team, Team.id == TeamScore.team_id)
            .where(TeamScore.round_id.in_(round_ids), TeamScore.rank == 1)
        )
        for row in (await db.execute(top_query)).all():
            top_team_map[row.round_id] = row.name

    for rnd in completed_rounds:
        if rnd.completed_at:
            events.append(TimelineEvent(
                timestamp=rnd.completed_at,
                type="round_completed",
                details={
                    "round_number": rnd.round_number,
                    "top_team": top_team_map.get(rnd.id),
                },
            ))

    # 3) 플래그 탈취 이벤트 — 해당 라운드 범위의 correct 제출
    flag_query = (
        select(
            FlagSubmission.submitted_at,
            Team.name.label("attacker_name"),
        )
        .join(Team, Team.id == FlagSubmission.submitter_team_id)
        .where(
            FlagSubmission.competition_id == competition_id,
            FlagSubmission.verdict == "correct",
        )
    )
    if round_id_number_map:
        flag_query = flag_query.where(FlagSubmission.round_id.in_(list(round_id_number_map.keys())))

    # 서브쿼리로 victim_team, service_name, round_number 추가
    from sqlalchemy.orm import aliased

    VictimTeam = aliased(Team)
    flag_detail_query = (
        select(
            FlagSubmission.submitted_at,
            Team.name.label("attacker_name"),
            VictimTeam.name.label("victim_name"),
            VulnService.name.label("service_name"),
            ScoringRound.round_number,
        )
        .join(Team, Team.id == FlagSubmission.submitter_team_id)
        .join(VictimTeam, VictimTeam.id == FlagSubmission.target_team_id, isouter=True)
        .join(VulnService, VulnService.id == FlagSubmission.service_id, isouter=True)
        .join(ScoringRound, ScoringRound.id == FlagSubmission.round_id, isouter=True)
        .where(
            FlagSubmission.competition_id == competition_id,
            FlagSubmission.verdict == "correct",
        )
    )
    if round_id_number_map:
        flag_detail_query = flag_detail_query.where(
            FlagSubmission.round_id.in_(list(round_id_number_map.keys()))
        )
    flag_detail_query = flag_detail_query.order_by(FlagSubmission.submitted_at)

    flag_rows = (await db.execute(flag_detail_query)).all()
    for frow in flag_rows:
        events.append(TimelineEvent(
            timestamp=frow.submitted_at,
            type="flag_captured",
            details={
                "attacker_team": frow.attacker_name,
                "victim_team": frow.victim_name,
                "service": frow.service_name,
                "round_number": frow.round_number,
            },
        ))

    # 4) 긴급 일시중단 이벤트 — audit_logs에서 pause 액션 조회
    pause_query = (
        select(OpsAuditLog)
        .where(
            OpsAuditLog.target_type == "competition",
            OpsAuditLog.target_id == competition_id,
            OpsAuditLog.action == "ops.competition.pause",
        )
        .order_by(OpsAuditLog.created_at)
    )
    pause_logs = (await db.execute(pause_query)).scalars().all()
    for log in pause_logs:
        details: dict = {}
        if log.details and isinstance(log.details, dict):
            details["reason"] = log.details.get("reason", "")
        details["operator"] = log.actor_name
        events.append(TimelineEvent(
            timestamp=log.created_at,
            type="emergency_pause",
            details=details,
        ))

    # 시간순 정렬
    events.sort(key=lambda e: e.timestamp)

    return TimelineResponse(
        competition_id=comp.id,
        total_rounds=total_rounds,
        events=events,
    )


# -- 3) GET /export --

@router.get("/export")
async def export_competition_data(
    competition_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
) -> StreamingResponse:
    """대회 전체 데이터를 ZIP 파일로 내보낸다. admin 전용, finished/archived 상태에서만 가능."""
    comp = await _get_competition_or_404(db, competition_id)
    _require_finished(comp)

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # 1) results.json — 결과 리포트 전체를 JSON으로
        results_resp = await get_competition_results(
            competition_id=competition_id,
            db=db,
            current_operator=current_operator,
        )
        zf.writestr("results.json", results_resp.model_dump_json(indent=2))

        # 2) rounds.csv
        rounds = (await db.execute(
            select(ScoringRound)
            .where(ScoringRound.competition_id == competition_id)
            .order_by(ScoringRound.round_number)
        )).scalars().all()
        zf.writestr("rounds.csv", _to_csv(
            headers=["id", "round_number", "status", "started_at", "completed_at", "error_detail"],
            rows=[
                [str(r.id), r.round_number, r.status, r.started_at, r.completed_at, r.error_detail or ""]
                for r in rounds
            ],
        ))

        # 3) scores.csv
        scores = (await db.execute(
            select(
                TeamScore.id,
                TeamScore.round_id,
                TeamScore.team_id,
                Team.name.label("team_name"),
                TeamScore.attack_score,
                TeamScore.defense_score,
                TeamScore.sla_score,
                TeamScore.bonus_score,
                TeamScore.total_score,
                TeamScore.rank,
            )
            .join(Team, Team.id == TeamScore.team_id)
            .join(ScoringRound, ScoringRound.id == TeamScore.round_id)
            .where(ScoringRound.competition_id == competition_id)
            .order_by(ScoringRound.round_number, TeamScore.rank)
        )).all()
        zf.writestr("scores.csv", _to_csv(
            headers=["id", "round_id", "team_id", "team_name", "attack_score", "defense_score", "sla_score", "bonus_score", "total_score", "rank"],
            rows=[
                [str(s.id), str(s.round_id), str(s.team_id), s.team_name,
                 s.attack_score, s.defense_score, s.sla_score, s.bonus_score, s.total_score, s.rank]
                for s in scores
            ],
        ))

        # 4) flags.csv
        flags = (await db.execute(
            select(Flag)
            .join(ScoringRound, ScoringRound.id == Flag.round_id)
            .where(ScoringRound.competition_id == competition_id)
            .order_by(ScoringRound.round_number)
        )).scalars().all()
        zf.writestr("flags.csv", _to_csv(
            headers=["id", "round_id", "team_id", "service_id", "flag_value", "is_active", "planted_at", "expires_at"],
            rows=[
                [str(f.id), str(f.round_id), str(f.team_id), str(f.service_id),
                 f.flag_value, f.is_active, f.planted_at, f.expires_at]
                for f in flags
            ],
        ))

        # 5) submissions.csv
        submissions = (await db.execute(
            select(FlagSubmission)
            .where(FlagSubmission.competition_id == competition_id)
            .order_by(FlagSubmission.submitted_at)
        )).scalars().all()
        zf.writestr("submissions.csv", _to_csv(
            headers=["id", "round_id", "submitter_team_id", "target_team_id", "service_id", "submitted_flag", "verdict", "submitted_at"],
            rows=[
                [str(s.id), str(s.round_id) if s.round_id else "", str(s.submitter_team_id),
                 str(s.target_team_id) if s.target_team_id else "", str(s.service_id) if s.service_id else "",
                 s.submitted_flag, s.verdict, s.submitted_at]
                for s in submissions
            ],
        ))

        # 6) sla_checks.csv
        sla_checks = (await db.execute(
            select(SlaCheck)
            .join(ScoringRound, ScoringRound.id == SlaCheck.round_id)
            .where(ScoringRound.competition_id == competition_id)
            .order_by(ScoringRound.round_number)
        )).scalars().all()
        zf.writestr("sla_checks.csv", _to_csv(
            headers=["id", "round_id", "team_id", "service_id", "check_type", "is_up", "response_time_ms", "error_message", "checked_at"],
            rows=[
                [str(c.id), str(c.round_id), str(c.team_id), str(c.service_id),
                 c.check_type, c.is_up, c.response_time_ms or "", c.error_message or "", c.checked_at]
                for c in sla_checks
            ],
        ))

        # 7) audit_logs.csv — 해당 대회 관련 감사 로그
        audit_logs = (await db.execute(
            select(OpsAuditLog)
            .where(
                OpsAuditLog.target_type == "competition",
                OpsAuditLog.target_id == competition_id,
            )
            .order_by(OpsAuditLog.created_at)
        )).scalars().all()
        zf.writestr("audit_logs.csv", _to_csv(
            headers=["id", "actor_id", "actor_name", "action", "target_type", "target_id", "details", "ip_address", "created_at"],
            rows=[
                [str(a.id), str(a.actor_id) if a.actor_id else "", a.actor_name,
                 a.action, a.target_type or "", str(a.target_id) if a.target_id else "",
                 json.dumps(a.details, ensure_ascii=False) if a.details else "",
                 a.ip_address or "", a.created_at]
                for a in audit_logs
            ],
        ))

    zip_buffer.seek(0)

    # 감사 로그 기록
    await record_audit(
        db, current_operator, "ops.competition.export",
        target_type="competition", target_id=comp.id,
        ip_address=request.client.host if request.client else None,
    )

    safe_name = comp.name.replace(" ", "-")[:50]
    filename = f"cstrike-{safe_name}-export.zip"

    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _to_csv(headers: list[str], rows: list[list]) -> str:
    """헤더와 행 리스트를 CSV 문자열로 변환한다."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return output.getvalue()
