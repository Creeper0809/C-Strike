"""스코어보드 공개 API 라우터 — 인증 불필요, 참가자/관전자용 읽기 전용."""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import case, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.competition import Competition
from app.models.flag import FlagSubmission
from app.models.scoring_round import ScoringRound
from app.models.sla_check import SlaCheck
from app.models.team import Team
from app.models.team_score import TeamScore
from app.models.team_service import TeamService
from app.models.vuln_service import VulnService
from app.models.vulnpack import VulnpackSchedule
from app.schemas.scoreboard import (
    EventEntry,
    MatrixTeamRow,
    RankingEntry,
    ScoreboardChartResponse,
    ScoreboardEventsResponse,
    ScoreboardInfoResponse,
    ScoreboardMatrixResponse,
    ScoreboardRankingsResponse,
    ScoreboardServiceEntry,
    ScoreboardTeamEntry,
    ScoreboardVulnpackEntry,
    ServiceInfo,
    ServiceStatusEntry,
)

router = APIRouter(tags=["스코어보드 (공개)"])


# ── 상수 ────────────────────────────────────────────────────

# 팀 색상 팔레트 (스코어보드 v2 프론트 기본값과 동일)
_TEAM_COLOR_PALETTE: tuple[str, ...] = (
    "#ff5252", "#448aff", "#69f0ae", "#ffd740",
    "#e040fb", "#ff6e40", "#00e5ff", "#b388ff",
)


# ── 헬퍼 함수 ──────────────────────────────────────────────

async def _get_competition_or_404(db: AsyncSession, competition_id: UUID) -> Competition:
    """대회를 조회하고, 없으면 404를 반환한다."""
    result = await db.execute(
        select(Competition).where(Competition.id == competition_id)
    )
    comp = result.scalar_one_or_none()
    if comp is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="대회를 찾을 수 없습니다.",
        )
    return comp


async def _get_current_round_number(db: AsyncSession, competition_id: UUID) -> int:
    """대회의 현재(최신 완료) 라운드 번호를 반환한다."""
    result = await db.execute(
        select(func.max(ScoringRound.round_number)).where(
            ScoringRound.competition_id == competition_id,
        )
    )
    return result.scalar_one() or 0


async def _get_latest_completed_round(db: AsyncSession, competition_id: UUID) -> ScoringRound | None:
    """가장 최근 완료된 라운드를 반환한다."""
    result = await db.execute(
        select(ScoringRound)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
        )
        .order_by(ScoringRound.round_number.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _get_approved_team_count(db: AsyncSession, competition_id: UUID) -> int:
    """승인된 팀 수를 반환한다."""
    result = await db.execute(
        select(func.count()).select_from(Team).where(
            Team.competition_id == competition_id,
            Team.status.in_(["approved", "active"]),
        )
    )
    return result.scalar_one()


async def _get_active_service_count(db: AsyncSession, competition_id: UUID) -> int:
    """활성화된 서비스 수를 반환한다."""
    result = await db.execute(
        select(func.count()).select_from(VulnService).where(
            VulnService.competition_id == competition_id,
            VulnService.status == "active",
        )
    )
    return result.scalar_one()


# ── 엔드포인트 ──────────────────────────────────────────────


class ActiveCompetitionEntry(BaseModel):
    """공개 활성 대회 항목 — 스코어보드 서버가 부팅 시 자동 대회 선택에 사용."""
    id: UUID
    name: str
    status: str
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None


class ActiveCompetitionsResponse(BaseModel):
    """GET /active-competitions 응답."""
    competitions: list[ActiveCompetitionEntry]


@router.get("/active-competitions", response_model=ActiveCompetitionsResponse)
async def get_active_competitions(
    db: AsyncSession = Depends(get_db),
) -> ActiveCompetitionsResponse:
    """종료되지 않은(finished 외) 대회 목록을 반환한다 (인증 불필요).

    스코어보드 서버가 기동 시 ``COMPETITION_ID`` 환경변수가 비어있으면
    이 엔드포인트를 호출해 첫 번째 활성 대회를 자동 선택한다.
    우선순위: running > ready > draft (이후 created_at 내림차순).
    """
    result = await db.execute(
        select(Competition)
        .where(Competition.status != "finished")
        .order_by(
            # running을 최우선으로, 그 다음 ready, draft 순으로 정렬
            case(
                (Competition.status == "running", 0),
                (Competition.status == "ready", 1),
                (Competition.status == "draft", 2),
                else_=3,
            ),
            Competition.created_at.desc(),
        )
    )
    rows = list(result.scalars().all())
    return ActiveCompetitionsResponse(
        competitions=[
            ActiveCompetitionEntry(
                id=c.id,
                name=c.name,
                status=c.status,
                scheduled_start_at=c.scheduled_start_at,
                scheduled_end_at=c.scheduled_end_at,
            )
            for c in rows
        ]
    )


@router.get("/{competition_id}/info")
async def get_scoreboard_info(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> ScoreboardInfoResponse:
    """대회 기본 정보를 조회한다 (인증 불필요).

    스코어보드 v2 연동을 위해 팀/서비스/취약점팩 메타데이터를 함께 반환한다.
    """
    comp = await _get_competition_or_404(db, competition_id)

    current_round = await _get_current_round_number(db, competition_id)
    total_teams = await _get_approved_team_count(db, competition_id)
    total_services = await _get_active_service_count(db, competition_id)

    # 팀 목록 (승인/활성 팀만, 등록 순서대로 색상 고정 매핑)
    teams_q = await db.execute(
        select(Team)
        .where(
            Team.competition_id == competition_id,
            Team.status.in_(["approved", "active"]),
        )
        .order_by(Team.created_at.asc())
    )
    team_rows = list(teams_q.scalars().all())
    team_entries = [
        ScoreboardTeamEntry(
            id=str(t.id),
            name=t.name,
            color=_TEAM_COLOR_PALETTE[i % len(_TEAM_COLOR_PALETTE)],
        )
        for i, t in enumerate(team_rows)
    ]

    # 취약점팩 스케줄 (pack_number 오름차순)
    packs_q = await db.execute(
        select(VulnpackSchedule)
        .where(VulnpackSchedule.competition_id == competition_id)
        .order_by(VulnpackSchedule.pack_number.asc())
    )
    pack_rows = list(packs_q.scalars().all())

    # 팩에 포함된 서비스 ID 집합 → 이름 일괄 매핑
    pack_service_ids: set = set()
    for pack in pack_rows:
        if pack.service_ids:
            pack_service_ids.update(str(sid) for sid in pack.service_ids)

    svc_name_by_id: dict[str, VulnService] = {}
    if pack_service_ids:
        svc_name_q = await db.execute(
            select(VulnService).where(VulnService.id.in_(pack_service_ids))
        )
        svc_name_by_id = {str(s.id): s for s in svc_name_q.scalars().all()}

    vulnpack_entries = [
        ScoreboardVulnpackEntry(
            pack_number=pack.pack_number,
            released=(pack.status == "released"),
            services=[
                svc_name_by_id[str(sid)].name
                for sid in (pack.service_ids or [])
                if str(sid) in svc_name_by_id
            ],
        )
        for pack in pack_rows
    ]

    # 전체 active 서비스 (대회 범위 필터 — 기존 total_services와 동일 기준)
    all_svc_q = await db.execute(
        select(VulnService)
        .where(
            VulnService.competition_id == competition_id,
            VulnService.status == "active",
        )
        .order_by(VulnService.name.asc())
    )
    all_svc_rows = list(all_svc_q.scalars().all())
    all_service_entries = [
        ScoreboardServiceEntry(
            id=str(s.id),
            name=s.name,
            category=s.category,
        )
        for s in all_svc_rows
    ]

    # 공개(released)된 팩에 속한 서비스만 노출 (참가자용 뷰)
    released_service_id_set: set[str] = set()
    for pack in pack_rows:
        if pack.status == "released" and pack.service_ids:
            released_service_id_set.update(str(sid) for sid in pack.service_ids)
    released_service_entries = [
        svc for svc in all_service_entries if svc.id in released_service_id_set
    ]

    # is_frozen: Competition 모델에 해당 필드가 없을 수 있어 안전 조회
    is_frozen_value = bool(getattr(comp, "is_frozen", False))

    return ScoreboardInfoResponse(
        competition_id=comp.id,
        name=comp.name,
        status=comp.status,
        scheduled_start_at=comp.scheduled_start_at,
        scheduled_end_at=comp.scheduled_end_at,
        actual_start_at=comp.actual_start_at,
        current_round=current_round,
        scoring_interval_seconds=comp.scoring_round_interval_seconds,
        total_teams=total_teams,
        total_services=total_services,
        is_frozen=is_frozen_value,
        teams=team_entries,
        services=released_service_entries,
        all_services=all_service_entries,
        vulnpacks=vulnpack_entries,
    )


@router.get("/{competition_id}/rankings")
async def get_scoreboard_rankings(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> ScoreboardRankingsResponse:
    """실시간 팀 순위표를 조회한다 (인증 불필요).

    최신 완료 라운드의 TeamScore 데이터를 기반으로 순위를 산출한다.
    이전 라운드 대비 순위 변동(rank_change)도 포함한다.
    """
    comp = await _get_competition_or_404(db, competition_id)
    latest_round = await _get_latest_completed_round(db, competition_id)

    if latest_round is None:
        # 채점 전이라도 등록된 팀 목록은 표시
        pre_teams_result = await db.execute(
            select(Team.name)
            .where(
                Team.competition_id == competition_id,
                Team.status.in_(["approved", "active"]),
            )
            .order_by(Team.name)
        )
        pre_rankings = [
            RankingEntry(
                rank=idx,
                rank_change=0,
                team_name=row.name,
                total_score=0.0,
                attack_score=0.0,
                defense_score=0.0,
                sla_percentage=100.0,
                flags_captured=0,
                services_up=0,
                services_total=0,
            )
            for idx, row in enumerate(pre_teams_result.all(), start=1)
        ]
        return ScoreboardRankingsResponse(
            competition_id=comp.id,
            round_number=0,
            updated_at=None,
            rankings=pre_rankings,
        )

    # 최신 라운드 팀 점수 (누적 합산)
    cumulative_q = (
        select(
            TeamScore.team_id,
            func.sum(TeamScore.total_score).label("total"),
            func.sum(TeamScore.attack_score).label("attack"),
            func.sum(TeamScore.defense_score).label("defense"),
        )
        .join(ScoringRound, TeamScore.round_id == ScoringRound.id)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
            ScoringRound.round_number <= latest_round.round_number,
        )
        .group_by(TeamScore.team_id)
    )
    cumul_result = await db.execute(cumulative_q)
    cumul_rows = cumul_result.all()

    if not cumul_rows:
        return ScoreboardRankingsResponse(
            competition_id=comp.id,
            round_number=latest_round.round_number,
            updated_at=latest_round.completed_at,
            rankings=[],
        )

    # 팀 이름 조회
    team_ids = [row.team_id for row in cumul_rows]
    teams_result = await db.execute(
        select(Team.id, Team.name).where(Team.id.in_(team_ids))
    )
    team_name_map: dict[UUID, str] = {row.id: row.name for row in teams_result.all()}

    # SLA 퍼센티지 계산 (전체 라운드 중 is_up=True 비율)
    sla_q = (
        select(
            SlaCheck.team_id,
            (func.sum(case((SlaCheck.is_up.is_(True), 1), else_=0)) * 100.0
             / func.count()).label("sla_pct"),
        )
        .join(ScoringRound, SlaCheck.round_id == ScoringRound.id)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
        )
        .group_by(SlaCheck.team_id)
    )
    sla_result = await db.execute(sla_q)
    sla_map: dict[UUID, float] = {row.team_id: float(row.sla_pct) for row in sla_result.all()}

    # 플래그 탈취 수
    flags_q = (
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
    flags_result = await db.execute(flags_q)
    flags_map: dict[UUID, int] = {row.submitter_team_id: row.cnt for row in flags_result.all()}

    # 활성 서비스 수
    total_services = await _get_active_service_count(db, competition_id)
    services_up_q = (
        select(
            TeamService.team_id,
            func.count().label("up_count"),
        )
        .where(
            TeamService.team_id.in_(team_ids),
            TeamService.status == "running",
            TeamService.last_health_check_result.is_(True),
        )
        .group_by(TeamService.team_id)
    )
    services_up_result = await db.execute(services_up_q)
    services_up_map: dict[UUID, int] = {
        row.team_id: row.up_count for row in services_up_result.all()
    }

    # 이전 라운드 순위 (rank_change 계산용)
    prev_rank_map: dict[UUID, int] = {}
    if latest_round.round_number > 1:
        prev_round_result = await db.execute(
            select(ScoringRound.id).where(
                ScoringRound.competition_id == competition_id,
                ScoringRound.round_number == latest_round.round_number - 1,
                ScoringRound.status == "completed",
            )
        )
        prev_round_id = prev_round_result.scalar_one_or_none()
        if prev_round_id is not None:
            prev_q = await db.execute(
                select(TeamScore.team_id, TeamScore.rank)
                .where(TeamScore.round_id == prev_round_id, TeamScore.rank.is_not(None))
            )
            prev_rank_map = {row.team_id: row.rank for row in prev_q.all()}

    # 순위 산출 (총점 내림차순)
    sorted_rows = sorted(cumul_rows, key=lambda r: float(r.total), reverse=True)

    rankings: list[RankingEntry] = []
    for rank_idx, row in enumerate(sorted_rows, start=1):
        prev_rank = prev_rank_map.get(row.team_id)
        rank_change = (prev_rank - rank_idx) if prev_rank is not None else 0

        rankings.append(RankingEntry(
            rank=rank_idx,
            rank_change=rank_change,
            team_name=team_name_map.get(row.team_id, "알 수 없음"),
            total_score=float(row.total),
            attack_score=float(row.attack),
            defense_score=float(row.defense),
            sla_percentage=round(sla_map.get(row.team_id, 0.0), 1),
            flags_captured=flags_map.get(row.team_id, 0),
            services_up=services_up_map.get(row.team_id, 0),
            services_total=total_services,
        ))

    return ScoreboardRankingsResponse(
        competition_id=comp.id,
        round_number=latest_round.round_number,
        updated_at=latest_round.completed_at,
        rankings=rankings,
    )


@router.get("/{competition_id}/chart")
async def get_scoreboard_chart(
    competition_id: UUID,
    top: int = Query(default=10, ge=1, le=20, description="상위 N개 팀"),
    from_round: int = Query(default=1, ge=1, description="시작 라운드"),
    interval: int = Query(default=1, ge=1, description="데이터 간격"),
    db: AsyncSession = Depends(get_db),
) -> ScoreboardChartResponse:
    """점수 추이 차트 데이터를 조회한다 (인증 불필요).

    라운드별 팀 누적 점수를 반환하며, top/from_round/interval 파라미터로 필터링한다.
    """
    comp = await _get_competition_or_404(db, competition_id)
    total_rounds = await _get_current_round_number(db, competition_id)

    if total_rounds == 0:
        return ScoreboardChartResponse(
            competition_id=comp.id,
            total_rounds=0,
            teams=[],
            rounds=[],
            scores={},
        )

    # 완료된 라운드 목록 (interval 적용)
    rounds_q = await db.execute(
        select(ScoringRound.round_number, ScoringRound.id)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
            ScoringRound.round_number >= from_round,
        )
        .order_by(ScoringRound.round_number)
    )
    all_rounds = rounds_q.all()

    # interval 적용: 매 interval번째 라운드 + 마지막 라운드
    filtered_rounds: list[tuple] = []
    for r in all_rounds:
        if (r.round_number - from_round) % interval == 0:
            filtered_rounds.append(r)
    if all_rounds and (not filtered_rounds or filtered_rounds[-1].round_number != all_rounds[-1].round_number):
        filtered_rounds.append(all_rounds[-1])

    if not filtered_rounds:
        return ScoreboardChartResponse(
            competition_id=comp.id,
            total_rounds=total_rounds,
            teams=[],
            rounds=[],
            scores={},
        )

    round_numbers = [r.round_number for r in filtered_rounds]

    # 상위 N팀 결정 (최신 라운드 기준 누적 총점)
    latest_round_number = all_rounds[-1].round_number if all_rounds else 0
    top_teams_q = (
        select(
            TeamScore.team_id,
            func.sum(TeamScore.total_score).label("total"),
        )
        .join(ScoringRound, TeamScore.round_id == ScoringRound.id)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
        )
        .group_by(TeamScore.team_id)
        .order_by(desc("total"))
        .limit(top)
    )
    top_result = await db.execute(top_teams_q)
    top_team_ids = [row.team_id for row in top_result.all()]

    if not top_team_ids:
        return ScoreboardChartResponse(
            competition_id=comp.id,
            total_rounds=total_rounds,
            teams=[],
            rounds=round_numbers,
            scores={},
        )

    # 팀 이름 조회
    teams_result = await db.execute(
        select(Team.id, Team.name).where(Team.id.in_(top_team_ids))
    )
    team_name_map: dict[UUID, str] = {row.id: row.name for row in teams_result.all()}

    # 라운드별 누적 점수 계산
    scores: dict[str, list[float]] = {team_name_map[tid]: [] for tid in top_team_ids}

    for rnd in filtered_rounds:
        # 해당 라운드까지의 누적 합산
        cumul_q = (
            select(
                TeamScore.team_id,
                func.sum(TeamScore.total_score).label("cumulative"),
            )
            .join(ScoringRound, TeamScore.round_id == ScoringRound.id)
            .where(
                ScoringRound.competition_id == competition_id,
                ScoringRound.status == "completed",
                ScoringRound.round_number <= rnd.round_number,
                TeamScore.team_id.in_(top_team_ids),
            )
            .group_by(TeamScore.team_id)
        )
        cumul_result = await db.execute(cumul_q)
        cumul_map = {row.team_id: float(row.cumulative) for row in cumul_result.all()}

        for tid in top_team_ids:
            team_name = team_name_map[tid]
            scores[team_name].append(cumul_map.get(tid, 0.0))

    team_names_ordered = [team_name_map[tid] for tid in top_team_ids]

    return ScoreboardChartResponse(
        competition_id=comp.id,
        total_rounds=total_rounds,
        teams=team_names_ordered,
        rounds=round_numbers,
        scores=scores,
    )


@router.get("/{competition_id}/matrix")
async def get_scoreboard_matrix(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> ScoreboardMatrixResponse:
    """서비스 상태 매트릭스를 조회한다 (인증 불필요).

    팀 x 서비스 격자에서 각 셀의 is_up 상태와 SLA 퍼센티지를 반환한다.
    """
    comp = await _get_competition_or_404(db, competition_id)
    current_round = await _get_current_round_number(db, competition_id)

    # 활성 서비스 목록
    services_result = await db.execute(
        select(VulnService.id, VulnService.name)
        .where(
            VulnService.competition_id == competition_id,
            VulnService.status == "active",
        )
        .order_by(VulnService.name)
    )
    services = services_result.all()
    service_infos = [ServiceInfo(id=s.id, name=s.name) for s in services]
    service_ids = [s.id for s in services]

    if not service_ids:
        return ScoreboardMatrixResponse(
            competition_id=comp.id,
            round_number=current_round,
            services=[],
            matrix=[],
        )

    # 승인된 팀 목록
    teams_result = await db.execute(
        select(Team.id, Team.name)
        .where(
            Team.competition_id == competition_id,
            Team.status.in_(["approved", "active"]),
        )
        .order_by(Team.name)
    )
    teams = teams_result.all()

    if not teams:
        return ScoreboardMatrixResponse(
            competition_id=comp.id,
            round_number=current_round,
            services=service_infos,
            matrix=[],
        )

    team_ids = [t.id for t in teams]

    # 최신 SLA 체크 결과 (가장 최근 라운드)
    latest_sla_q = (
        select(
            SlaCheck.team_id,
            SlaCheck.service_id,
            SlaCheck.is_up,
        )
        .join(ScoringRound, SlaCheck.round_id == ScoringRound.id)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.round_number == current_round,
            SlaCheck.team_id.in_(team_ids),
            SlaCheck.service_id.in_(service_ids),
        )
    )
    latest_sla_result = await db.execute(latest_sla_q)
    latest_sla_map: dict[tuple[UUID, UUID], bool] = {
        (row.team_id, row.service_id): row.is_up
        for row in latest_sla_result.all()
    }

    # 전체 라운드 SLA 퍼센티지 (팀 x 서비스)
    sla_pct_q = (
        select(
            SlaCheck.team_id,
            SlaCheck.service_id,
            (func.sum(case((SlaCheck.is_up.is_(True), 1), else_=0)) * 100.0
             / func.count()).label("sla_pct"),
        )
        .join(ScoringRound, SlaCheck.round_id == ScoringRound.id)
        .where(
            ScoringRound.competition_id == competition_id,
            ScoringRound.status == "completed",
            SlaCheck.team_id.in_(team_ids),
            SlaCheck.service_id.in_(service_ids),
        )
        .group_by(SlaCheck.team_id, SlaCheck.service_id)
    )
    sla_pct_result = await db.execute(sla_pct_q)
    sla_pct_map: dict[tuple[UUID, UUID], float] = {
        (row.team_id, row.service_id): float(row.sla_pct)
        for row in sla_pct_result.all()
    }

    # 매트릭스 구성
    matrix: list[MatrixTeamRow] = []
    for team in teams:
        statuses: list[ServiceStatusEntry] = []
        for svc in services:
            is_up = latest_sla_map.get((team.id, svc.id), False)
            sla_pct = round(sla_pct_map.get((team.id, svc.id), 0.0), 1)
            statuses.append(ServiceStatusEntry(
                service_id=svc.id,
                is_up=is_up,
                sla_percentage=sla_pct,
            ))
        matrix.append(MatrixTeamRow(team_name=team.name, statuses=statuses))

    return ScoreboardMatrixResponse(
        competition_id=comp.id,
        round_number=current_round,
        services=service_infos,
        matrix=matrix,
    )


@router.get("/{competition_id}/events")
async def get_scoreboard_events(
    competition_id: UUID,
    limit: int = Query(default=20, ge=1, le=100, description="조회할 이벤트 수"),
    type: str | None = Query(default=None, description="이벤트 타입 필터"),
    db: AsyncSession = Depends(get_db),
) -> ScoreboardEventsResponse:
    """최근 이벤트 피드를 조회한다 (인증 불필요).

    플래그 탈취, SLA 변동 등의 이벤트를 시간 역순으로 반환한다.
    """
    comp = await _get_competition_or_404(db, competition_id)

    valid_types = {"flag_captured", "sla_change", "rank_change"}
    if type is not None and type not in valid_types:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"잘못된 type 값입니다. 허용: {', '.join(sorted(valid_types))}",
        )

    events: list[EventEntry] = []

    # 플래그 탈취 이벤트 수집
    if type is None or type == "flag_captured":
        flag_q = (
            select(
                FlagSubmission.id,
                FlagSubmission.submitted_at,
                ScoringRound.round_number,
                Team.name.label("attacker_name"),
            )
            .join(ScoringRound, FlagSubmission.round_id == ScoringRound.id, isouter=True)
            .join(Team, FlagSubmission.submitter_team_id == Team.id)
            .where(
                FlagSubmission.competition_id == competition_id,
                FlagSubmission.verdict == "correct",
            )
            .order_by(FlagSubmission.submitted_at.desc())
            .limit(limit)
        )
        flag_result = await db.execute(flag_q)
        flag_rows = flag_result.all()

        # 대상 팀 이름과 서비스 이름을 일괄 조회
        for row in flag_rows:
            # 개별 제출 건의 상세 정보 조회
            detail_q = await db.execute(
                select(
                    FlagSubmission.target_team_id,
                    FlagSubmission.service_id,
                )
                .where(FlagSubmission.id == row.id)
            )
            detail = detail_q.one()

            victim_name = "알 수 없음"
            if detail.target_team_id is not None:
                victim_q = await db.execute(
                    select(Team.name).where(Team.id == detail.target_team_id)
                )
                victim_name = victim_q.scalar_one_or_none() or "알 수 없음"

            service_name = "알 수 없음"
            if detail.service_id is not None:
                svc_q = await db.execute(
                    select(VulnService.name).where(VulnService.id == detail.service_id)
                )
                service_name = svc_q.scalar_one_or_none() or "알 수 없음"

            events.append(EventEntry(
                id=row.id,
                type="flag_captured",
                timestamp=row.submitted_at,
                round_number=row.round_number or 0,
                details={
                    "attacker": row.attacker_name,
                    "victim": victim_name,
                    "service": service_name,
                },
            ))

    # SLA 변동 이벤트 수집 (최근 라운드에서 상태가 바뀐 건)
    if type is None or type == "sla_change":
        current_round = await _get_current_round_number(db, competition_id)
        if current_round >= 1:
            # 현재 라운드의 SLA 체크 중 이전 라운드와 다른 건
            current_sla_q = (
                select(
                    SlaCheck.id,
                    SlaCheck.team_id,
                    SlaCheck.service_id,
                    SlaCheck.is_up,
                    SlaCheck.checked_at,
                    ScoringRound.round_number,
                )
                .join(ScoringRound, SlaCheck.round_id == ScoringRound.id)
                .where(
                    ScoringRound.competition_id == competition_id,
                    ScoringRound.round_number == current_round,
                )
                .order_by(SlaCheck.checked_at.desc())
                .limit(limit)
            )
            current_sla_result = await db.execute(current_sla_q)
            current_sla_rows = current_sla_result.all()

            if current_round >= 2:
                # 이전 라운드의 동일 팀/서비스 SLA 조회
                prev_sla_q = (
                    select(SlaCheck.team_id, SlaCheck.service_id, SlaCheck.is_up)
                    .join(ScoringRound, SlaCheck.round_id == ScoringRound.id)
                    .where(
                        ScoringRound.competition_id == competition_id,
                        ScoringRound.round_number == current_round - 1,
                    )
                )
                prev_result = await db.execute(prev_sla_q)
                prev_map: dict[tuple[UUID, UUID], bool] = {
                    (row.team_id, row.service_id): row.is_up
                    for row in prev_result.all()
                }

                for row in current_sla_rows:
                    prev_status = prev_map.get((row.team_id, row.service_id))
                    if prev_status is not None and prev_status != row.is_up:
                        team_name_q = await db.execute(
                            select(Team.name).where(Team.id == row.team_id)
                        )
                        t_name = team_name_q.scalar_one_or_none() or "알 수 없음"

                        svc_name_q = await db.execute(
                            select(VulnService.name).where(VulnService.id == row.service_id)
                        )
                        s_name = svc_name_q.scalar_one_or_none() or "알 수 없음"

                        events.append(EventEntry(
                            id=row.id,
                            type="sla_change",
                            timestamp=row.checked_at,
                            round_number=row.round_number,
                            details={
                                "team": t_name,
                                "service": s_name,
                                "previous_status": prev_status,
                                "current_status": row.is_up,
                            },
                        ))

    # 순위 변동 이벤트 수집
    if type is None or type == "rank_change":
        current_round = await _get_current_round_number(db, competition_id)
        if current_round >= 2:
            # 현재 라운드 순위
            cur_round_q = await db.execute(
                select(ScoringRound.id, ScoringRound.completed_at).where(
                    ScoringRound.competition_id == competition_id,
                    ScoringRound.round_number == current_round,
                    ScoringRound.status == "completed",
                )
            )
            cur_round_row = cur_round_q.one_or_none()

            prev_round_q = await db.execute(
                select(ScoringRound.id).where(
                    ScoringRound.competition_id == competition_id,
                    ScoringRound.round_number == current_round - 1,
                    ScoringRound.status == "completed",
                )
            )
            prev_round_row = prev_round_q.one_or_none()

            if cur_round_row is not None and prev_round_row is not None:
                cur_ranks_q = await db.execute(
                    select(TeamScore.team_id, TeamScore.rank)
                    .where(TeamScore.round_id == cur_round_row.id, TeamScore.rank.is_not(None))
                )
                cur_ranks = {row.team_id: row.rank for row in cur_ranks_q.all()}

                prev_ranks_q = await db.execute(
                    select(TeamScore.team_id, TeamScore.rank)
                    .where(TeamScore.round_id == prev_round_row.id, TeamScore.rank.is_not(None))
                )
                prev_ranks = {row.team_id: row.rank for row in prev_ranks_q.all()}

                for team_id, cur_rank in cur_ranks.items():
                    prev_rank = prev_ranks.get(team_id)
                    if prev_rank is not None and prev_rank != cur_rank:
                        t_name_q = await db.execute(
                            select(Team.name).where(Team.id == team_id)
                        )
                        t_name = t_name_q.scalar_one_or_none() or "알 수 없음"

                        events.append(EventEntry(
                            id=uuid4(),
                            type="rank_change",
                            timestamp=cur_round_row.completed_at or datetime.now(timezone.utc),
                            round_number=current_round,
                            details={
                                "team": t_name,
                                "previous_rank": prev_rank,
                                "current_rank": cur_rank,
                            },
                        ))

    # 시간 역순 정렬 후 limit 적용
    events.sort(key=lambda e: e.timestamp, reverse=True)
    events = events[:limit]

    return ScoreboardEventsResponse(
        competition_id=comp.id,
        events=events,
    )
