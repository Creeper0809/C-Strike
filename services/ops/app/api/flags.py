"""플래그 관리 API 라우터 — 플래그 및 제출 기록 조회."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator
from app.models.competition import Competition
from app.models.flag import Flag, FlagSubmission
from app.models.operator import Operator
from app.models.scoring_round import ScoringRound
from app.models.team import Team
from app.models.vuln_service import VulnService
from app.schemas.flag import (
    FlagItem,
    FlagListResponse,
    FlagStatsResponse,
    FlagSubmissionDetail,
    FlagSubmissionItem,
    FlagSubmissionListResponse,
    ServiceStat,
    TeamAttackStat,
    TeamDefenseStat,
)

router = APIRouter(tags=["플래그 관리"])

VALID_VERDICTS = {"correct", "incorrect", "expired", "duplicate", "own_flag", "invalid_format"}


async def _get_competition_or_404(db: AsyncSession, competition_id: UUID) -> Competition:
    """대회 존재 확인 헬퍼."""
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


@router.get("/")
async def list_flags(
    competition_id: UUID,
    round_number: int | None = Query(None, description="라운드 번호 필터"),
    team_name: str | None = Query(None, description="팀명 필터 (부분 일치)"),
    service_name: str | None = Query(None, description="서비스명 필터 (부분 일치)"),
    is_active: bool | None = Query(None, description="활성 플래그만 필터"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> FlagListResponse:
    """플래그 목록을 조회한다."""
    await _get_competition_or_404(db, competition_id)

    # 기본 쿼리: Flag + ScoringRound(round_number) + Team(name) + VulnService(name) 조인
    base_query = (
        select(
            Flag.id,
            ScoringRound.round_number,
            Flag.round_id,
            Flag.team_id,
            Team.name.label("team_name"),
            Flag.service_id,
            VulnService.name.label("service_name"),
            Flag.flag_value,
            Flag.is_active,
            Flag.planted_at,
            Flag.expires_at,
        )
        .join(ScoringRound, Flag.round_id == ScoringRound.id)
        .join(Team, Flag.team_id == Team.id)
        .join(VulnService, Flag.service_id == VulnService.id)
        .where(ScoringRound.competition_id == competition_id)
    )

    count_query = (
        select(func.count())
        .select_from(Flag)
        .join(ScoringRound, Flag.round_id == ScoringRound.id)
        .where(ScoringRound.competition_id == competition_id)
    )

    # 필터
    if round_number is not None:
        base_query = base_query.where(ScoringRound.round_number == round_number)
        count_query = count_query.where(ScoringRound.round_number == round_number)
    if team_name is not None:
        pattern = f"%{team_name}%"
        base_query = base_query.where(Team.name.ilike(pattern))
        count_query = count_query.join(Team, Flag.team_id == Team.id).where(Team.name.ilike(pattern))
    if service_name is not None:
        pattern = f"%{service_name}%"
        base_query = base_query.where(VulnService.name.ilike(pattern))
        count_query = count_query.join(VulnService, Flag.service_id == VulnService.id).where(VulnService.name.ilike(pattern))
    if is_active is not None:
        base_query = base_query.where(Flag.is_active == is_active)
        count_query = count_query.where(Flag.is_active == is_active)

    total = (await db.execute(count_query)).scalar_one()
    offset = (page - 1) * size
    result = await db.execute(
        base_query.order_by(ScoringRound.round_number.desc(), Team.name)
        .offset(offset)
        .limit(size)
    )
    rows = result.all()

    items = [
        FlagItem(
            id=row.id,
            round_number=row.round_number,
            round_id=row.round_id,
            team_id=row.team_id,
            team_name=row.team_name,
            service_id=row.service_id,
            service_name=row.service_name,
            flag_value=row.flag_value,
            is_active=row.is_active,
            planted_at=row.planted_at,
            expires_at=row.expires_at,
        )
        for row in rows
    ]
    return FlagListResponse(items=items, total=total, page=page, size=size)


@router.get("/submissions")
async def list_flag_submissions(
    competition_id: UUID,
    submitter_team_name: str | None = Query(None, description="제출 팀명 필터 (부분 일치)"),
    target_team_name: str | None = Query(None, description="대상(피해) 팀명 필터 (부분 일치)"),
    verdict: str | None = Query(None, description="판정 필터"),
    round_number: int | None = Query(None, description="라운드 번호 필터"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> FlagSubmissionListResponse:
    """플래그 제출 기록을 조회한다."""
    await _get_competition_or_404(db, competition_id)

    if verdict is not None and verdict not in VALID_VERDICTS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"잘못된 verdict 값입니다. 허용: {', '.join(sorted(VALID_VERDICTS))}",
        )

    # 제출자 팀, 대상 팀 각각 별칭
    submitter_team = Team.__table__.alias("submitter_team")
    target_team = Team.__table__.alias("target_team")

    base_query = (
        select(
            FlagSubmission.id,
            FlagSubmission.competition_id,
            ScoringRound.round_number,
            FlagSubmission.submitter_team_id,
            submitter_team.c.name.label("submitter_team_name"),
            FlagSubmission.target_team_id,
            target_team.c.name.label("target_team_name"),
            FlagSubmission.service_id,
            VulnService.name.label("service_name"),
            FlagSubmission.submitted_flag,
            FlagSubmission.verdict,
            FlagSubmission.submitter_discord_id,
            FlagSubmission.submitted_at,
        )
        .join(submitter_team, FlagSubmission.submitter_team_id == submitter_team.c.id)
        .outerjoin(target_team, FlagSubmission.target_team_id == target_team.c.id)
        .outerjoin(VulnService, FlagSubmission.service_id == VulnService.id)
        .outerjoin(ScoringRound, FlagSubmission.round_id == ScoringRound.id)
        .where(FlagSubmission.competition_id == competition_id)
    )

    count_query = (
        select(func.count())
        .select_from(FlagSubmission)
        .where(FlagSubmission.competition_id == competition_id)
    )

    # 필터
    if submitter_team_name is not None:
        pattern = f"%{submitter_team_name}%"
        base_query = base_query.where(submitter_team.c.name.ilike(pattern))
        count_query = count_query.join(submitter_team, FlagSubmission.submitter_team_id == submitter_team.c.id).where(submitter_team.c.name.ilike(pattern))
    if target_team_name is not None:
        pattern = f"%{target_team_name}%"
        base_query = base_query.where(target_team.c.name.ilike(pattern))
        count_query = count_query.outerjoin(target_team, FlagSubmission.target_team_id == target_team.c.id).where(target_team.c.name.ilike(pattern))
    if verdict is not None:
        base_query = base_query.where(FlagSubmission.verdict == verdict)
        count_query = count_query.where(FlagSubmission.verdict == verdict)
    if round_number is not None:
        # base_query에서 이미 ScoringRound를 outerjoin 했으므로 where만 추가
        base_query = base_query.where(ScoringRound.round_number == round_number)
        count_query = (
            count_query
            .outerjoin(ScoringRound, FlagSubmission.round_id == ScoringRound.id)
            .where(ScoringRound.round_number == round_number)
        )

    total = (await db.execute(count_query)).scalar_one()
    offset = (page - 1) * size
    result = await db.execute(
        base_query.order_by(FlagSubmission.submitted_at.desc())
        .offset(offset)
        .limit(size)
    )
    rows = result.all()

    items = [
        FlagSubmissionItem(
            id=row.id,
            competition_id=row.competition_id,
            round_number=row.round_number,
            submitter_team_id=row.submitter_team_id,
            submitter_team_name=row.submitter_team_name,
            target_team_id=row.target_team_id,
            target_team_name=row.target_team_name,
            service_id=row.service_id,
            service_name=row.service_name,
            submitted_flag=row.submitted_flag,
            verdict=row.verdict,
            submitter_discord_id=row.submitter_discord_id,
            submitted_at=row.submitted_at,
        )
        for row in rows
    ]
    return FlagSubmissionListResponse(items=items, total=total, page=page, size=size)


@router.get("/submissions/{submission_id}")
async def get_flag_submission(
    competition_id: UUID,
    submission_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> FlagSubmissionDetail:
    """특정 제출 기록의 상세를 조회한다."""
    await _get_competition_or_404(db, competition_id)

    submitter_team = Team.__table__.alias("submitter_team")
    target_team = Team.__table__.alias("target_team")

    result = await db.execute(
        select(
            FlagSubmission.id,
            FlagSubmission.competition_id,
            FlagSubmission.round_id,
            ScoringRound.round_number,
            FlagSubmission.submitter_team_id,
            submitter_team.c.name.label("submitter_team_name"),
            FlagSubmission.target_team_id,
            target_team.c.name.label("target_team_name"),
            FlagSubmission.service_id,
            VulnService.name.label("service_name"),
            FlagSubmission.submitted_flag,
            FlagSubmission.flag_id,
            FlagSubmission.verdict,
            FlagSubmission.submitter_discord_id,
            FlagSubmission.submitted_at,
        )
        .join(submitter_team, FlagSubmission.submitter_team_id == submitter_team.c.id)
        .outerjoin(target_team, FlagSubmission.target_team_id == target_team.c.id)
        .outerjoin(VulnService, FlagSubmission.service_id == VulnService.id)
        .outerjoin(ScoringRound, FlagSubmission.round_id == ScoringRound.id)
        .where(
            FlagSubmission.competition_id == competition_id,
            FlagSubmission.id == submission_id,
        )
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="제출 기록을 찾을 수 없습니다.",
        )

    return FlagSubmissionDetail(
        id=row.id,
        competition_id=row.competition_id,
        round_id=row.round_id,
        round_number=row.round_number,
        submitter_team_id=row.submitter_team_id,
        submitter_team_name=row.submitter_team_name,
        target_team_id=row.target_team_id,
        target_team_name=row.target_team_name,
        service_id=row.service_id,
        service_name=row.service_name,
        submitted_flag=row.submitted_flag,
        flag_id=row.flag_id,
        verdict=row.verdict,
        submitter_discord_id=row.submitter_discord_id,
        submitted_at=row.submitted_at,
    )


@router.get("/stats")
async def get_flag_stats(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> FlagStatsResponse:
    """플래그 관련 통계를 조회한다."""
    await _get_competition_or_404(db, competition_id)

    # 1) 총 플래그 수
    total_flags = (
        await db.execute(
            select(func.count())
            .select_from(Flag)
            .join(ScoringRound, Flag.round_id == ScoringRound.id)
            .where(ScoringRound.competition_id == competition_id)
        )
    ).scalar_one()

    # 2) 총 제출 수
    total_submissions = (
        await db.execute(
            select(func.count())
            .select_from(FlagSubmission)
            .where(FlagSubmission.competition_id == competition_id)
        )
    ).scalar_one()

    # 3) 판정별 제출 수
    verdict_rows = (
        await db.execute(
            select(FlagSubmission.verdict, func.count().label("cnt"))
            .where(FlagSubmission.competition_id == competition_id)
            .group_by(FlagSubmission.verdict)
        )
    ).all()

    submissions_by_verdict: dict[str, int] = {}
    correct_count = 0
    for row in verdict_rows:
        submissions_by_verdict[row.verdict] = row.cnt
        if row.verdict == "correct":
            correct_count = row.cnt

    accuracy_rate = round((correct_count / total_submissions * 100), 1) if total_submissions > 0 else 0.0

    # 4) 팀별 공격 통계
    attack_rows = (
        await db.execute(
            select(
                FlagSubmission.submitter_team_id.label("team_id"),
                Team.name.label("team_name"),
                func.count().label("total_submissions"),
                func.count(case((FlagSubmission.verdict == "correct", 1))).label("correct_submissions"),
                func.count(distinct(FlagSubmission.target_team_id)).label("unique_teams_attacked"),
            )
            .join(Team, FlagSubmission.submitter_team_id == Team.id)
            .where(FlagSubmission.competition_id == competition_id)
            .group_by(FlagSubmission.submitter_team_id, Team.name)
            .order_by(func.count().desc())
        )
    ).all()

    team_attack_stats = [
        TeamAttackStat(
            team_id=row.team_id,
            team_name=row.team_name,
            total_submissions=row.total_submissions,
            correct_submissions=row.correct_submissions,
            accuracy_rate=round((row.correct_submissions / row.total_submissions * 100), 1) if row.total_submissions > 0 else 0.0,
            unique_teams_attacked=row.unique_teams_attacked,
        )
        for row in attack_rows
    ]

    # 5) 팀별 방어 통계
    # 각 팀이 소유한 총 플래그 수와 탈취당한(correct 제출) 수
    defense_rows = (
        await db.execute(
            select(
                Flag.team_id,
                Team.name.label("team_name"),
                func.count(Flag.id).label("flags_total"),
                func.count(
                    case((FlagSubmission.verdict == "correct", 1))
                ).label("flags_stolen"),
            )
            .join(ScoringRound, Flag.round_id == ScoringRound.id)
            .join(Team, Flag.team_id == Team.id)
            .outerjoin(
                FlagSubmission,
                (FlagSubmission.flag_id == Flag.id) & (FlagSubmission.verdict == "correct"),
            )
            .where(ScoringRound.competition_id == competition_id)
            .group_by(Flag.team_id, Team.name)
            .order_by(Team.name)
        )
    ).all()

    team_defense_stats = [
        TeamDefenseStat(
            team_id=row.team_id,
            team_name=row.team_name,
            flags_stolen=row.flags_stolen,
            flags_total=row.flags_total,
            defense_rate=round(((row.flags_total - row.flags_stolen) / row.flags_total * 100), 1) if row.flags_total > 0 else 100.0,
        )
        for row in defense_rows
    ]

    # 6) 서비스별 통계
    # 완료된 라운드 수
    completed_rounds = (
        await db.execute(
            select(func.count())
            .select_from(ScoringRound)
            .where(
                ScoringRound.competition_id == competition_id,
                ScoringRound.status == "completed",
            )
        )
    ).scalar_one()

    service_rows = (
        await db.execute(
            select(
                FlagSubmission.service_id,
                VulnService.name.label("service_name"),
                func.count().label("total_captures"),
            )
            .join(VulnService, FlagSubmission.service_id == VulnService.id)
            .where(
                FlagSubmission.competition_id == competition_id,
                FlagSubmission.verdict == "correct",
            )
            .group_by(FlagSubmission.service_id, VulnService.name)
            .order_by(func.count().desc())
        )
    ).all()

    service_stats = [
        ServiceStat(
            service_id=row.service_id,
            service_name=row.service_name,
            total_captures=row.total_captures,
            capture_rate_per_round=round(row.total_captures / completed_rounds, 1) if completed_rounds > 0 else 0.0,
        )
        for row in service_rows
    ]

    return FlagStatsResponse(
        competition_id=competition_id,
        total_flags_generated=total_flags,
        total_submissions=total_submissions,
        submissions_by_verdict=submissions_by_verdict,
        accuracy_rate=accuracy_rate,
        team_attack_stats=team_attack_stats,
        team_defense_stats=team_defense_stats,
        service_stats=service_stats,
    )
