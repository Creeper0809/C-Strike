"""피드백 API 라우터 — 참가자 피드백 조회 및 통계."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator
from app.models.competition import Competition
from app.models.feedback import Feedback
from app.models.operator import Operator
from app.models.team import Team, TeamMember
from app.schemas.feedback import (
    CategoryBreakdown,
    FeedbackItem,
    FeedbackListResponse,
    FeedbackStatsResponse,
)

router = APIRouter(tags=["피드백"])

VALID_CATEGORIES = {"general", "scoring", "network", "service", "organization"}


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
async def list_feedbacks(
    competition_id: UUID,
    category: str | None = Query(None, description="분류 필터"),
    rating_min: int | None = Query(None, ge=1, le=5, description="최소 별점"),
    rating_max: int | None = Query(None, ge=1, le=5, description="최대 별점"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> FeedbackListResponse:
    """피드백 목록을 조회한다."""
    await _get_competition_or_404(db, competition_id)

    if category is not None and category not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"잘못된 category 값입니다. 허용: {', '.join(sorted(VALID_CATEGORIES))}",
        )

    base_query = (
        select(
            Feedback.id,
            Feedback.competition_id,
            Feedback.discord_user_id,
            Feedback.discord_username,
            Feedback.team_id,
            Team.name.label("team_name"),
            Feedback.rating,
            Feedback.content,
            Feedback.category,
            Feedback.created_at,
        )
        .outerjoin(Team, Feedback.team_id == Team.id)
        .where(Feedback.competition_id == competition_id)
    )

    count_query = (
        select(func.count())
        .select_from(Feedback)
        .where(Feedback.competition_id == competition_id)
    )

    # 필터
    if category is not None:
        base_query = base_query.where(Feedback.category == category)
        count_query = count_query.where(Feedback.category == category)
    if rating_min is not None:
        base_query = base_query.where(Feedback.rating >= rating_min)
        count_query = count_query.where(Feedback.rating >= rating_min)
    if rating_max is not None:
        base_query = base_query.where(Feedback.rating <= rating_max)
        count_query = count_query.where(Feedback.rating <= rating_max)

    total = (await db.execute(count_query)).scalar_one()
    offset = (page - 1) * size
    result = await db.execute(
        base_query.order_by(Feedback.created_at.desc())
        .offset(offset)
        .limit(size)
    )
    rows = result.all()

    items = [
        FeedbackItem(
            id=row.id,
            competition_id=row.competition_id,
            discord_user_id=row.discord_user_id,
            discord_username=row.discord_username,
            team_id=row.team_id,
            team_name=row.team_name,
            rating=row.rating,
            content=row.content,
            category=row.category,
            created_at=row.created_at,
        )
        for row in rows
    ]
    return FeedbackListResponse(items=items, total=total, page=page, size=size)


@router.get("/stats")
async def get_feedback_stats(
    competition_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
) -> FeedbackStatsResponse:
    """피드백 통계를 조회한다."""
    await _get_competition_or_404(db, competition_id)

    # 1) 총 피드백 수, 평균 평점
    agg_result = await db.execute(
        select(
            func.count().label("total"),
            func.coalesce(func.avg(Feedback.rating), 0).label("avg_rating"),
        )
        .select_from(Feedback)
        .where(Feedback.competition_id == competition_id)
    )
    agg = agg_result.one()
    total_feedbacks = agg.total
    average_rating = round(float(agg.avg_rating), 1)

    # 2) 별점 분포 (1~5)
    dist_rows = (
        await db.execute(
            select(Feedback.rating, func.count().label("cnt"))
            .where(Feedback.competition_id == competition_id)
            .group_by(Feedback.rating)
        )
    ).all()

    rating_distribution: dict[str, int] = {str(i): 0 for i in range(1, 6)}
    for row in dist_rows:
        rating_distribution[str(row.rating)] = row.cnt

    # 3) 카테고리별 집계
    cat_rows = (
        await db.execute(
            select(
                Feedback.category,
                func.count().label("cnt"),
                func.avg(Feedback.rating).label("avg_rating"),
            )
            .where(Feedback.competition_id == competition_id)
            .group_by(Feedback.category)
        )
    ).all()

    category_breakdown: dict[str, CategoryBreakdown] = {}
    for row in cat_rows:
        category_breakdown[row.category] = CategoryBreakdown(
            count=row.cnt,
            average_rating=round(float(row.avg_rating), 1),
        )

    # 4) 참여율: 피드백 수 / 대회 참가 팀원 수 * 100
    # 승인된 팀원(TeamMember) 중 해당 대회에 속한 팀의 팀원만 카운트
    total_members = (
        await db.execute(
            select(func.count())
            .select_from(TeamMember)
            .join(Team, TeamMember.team_id == Team.id)
            .where(
                Team.competition_id == competition_id,
                TeamMember.status == "approved",
            )
        )
    ).scalar_one()

    participation_rate = round((total_feedbacks / total_members * 100), 1) if total_members > 0 else 0.0

    return FeedbackStatsResponse(
        competition_id=competition_id,
        total_feedbacks=total_feedbacks,
        average_rating=average_rating,
        rating_distribution=rating_distribution,
        category_breakdown=category_breakdown,
        participation_rate=participation_rate,
    )
