"""디스코드 봇 내부 API 라우터 — X-Bot-API-Key 헤더 인증."""

import re
import secrets
import string
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.utils.audit import record_bot_audit
from app.database import get_db
from app.models.config import CompetitionConfig
from app.models.competition import Competition
from app.models.feedback import Feedback
from app.models.flag import Flag, FlagSubmission
from app.models.scoring_round import ScoringRound
from app.models.sla_check import SlaCheck
from app.models.team import Team, TeamMember
from app.models.team_score import TeamScore
from app.models.team_service import TeamService
from app.models.ticket import Ticket
from app.models.vuln_service import VulnService
from app.schemas.bot_api import (
    BotCaptainActionRequest,
    BotFeedbackCreateRequest,
    BotFeedbackCreateResponse,
    BotFlagSubmitDetails,
    BotFlagSubmitRequest,
    BotFlagSubmitResponse,
    BotMemberActionResponse,
    BotMyTeamResponse,
    BotMyTeamScore,
    BotRankingItem,
    BotScoreResponse,
    BotServiceStatusItem,
    BotStatusResponse,
    BotTeamCreateRequest,
    BotTeamCreateResponse,
    BotTeamDeleteRequest,
    BotTeamDeleteResponse,
    BotTeamInfoResponse,
    BotTeamJoinRequest,
    BotTeamJoinResponse,
    BotTeamLeaveRequest,
    BotTeamListItem,
    BotTeamListResponse,
    BotTeamMemberInfo,
    BotTicketCreateRequest,
    BotTicketCreateResponse,
)

router = APIRouter(tags=["디스코드 봇 내부 API"])

# 플래그 형식 정규식: FLAG{...}
FLAG_PATTERN = re.compile(r"^FLAG\{.+\}$")


# ── 인증 의존성 ──────────────────────────────────────────

async def verify_bot_api_key(x_bot_api_key: str = Header(...)):
    """X-Bot-API-Key 헤더로 봇 인증."""
    if x_bot_api_key != settings.BOT_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 봇 API 키입니다.",
        )


# ── 공통 헬퍼 ────────────────────────────────────────────

def _generate_team_code(name: str) -> str:
    """팀명 기반 팀 코드 생성. 예: 'CyberPhoenix' → 'CP-A3F2'."""
    # 팀명에서 대문자 또는 첫 글자 추출 (최대 2자)
    initials = "".join(c for c in name if c.isupper())[:2]
    if len(initials) < 2:
        initials = name[:2].upper()
    suffix = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(4))
    return f"{initials}-{suffix}"


async def _get_competition_or_404(db: AsyncSession, competition_id: UUID) -> Competition:
    """대회 조회. 없으면 404."""
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


async def _get_team_or_404(db: AsyncSession, team_id: UUID) -> Team:
    """팀 조회. 없으면 404."""
    result = await db.execute(select(Team).where(Team.id == team_id))
    team = result.scalar_one_or_none()
    if team is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="팀을 찾을 수 없습니다.",
        )
    return team


async def _find_team_by_discord_id(
    db: AsyncSession, competition_id: UUID, discord_user_id: str,
) -> tuple[Team, TeamMember] | None:
    """디스코드 ID로 해당 대회에서 소속 팀과 멤버 레코드를 조회한다."""
    result = await db.execute(
        select(TeamMember, Team)
        .join(Team, TeamMember.team_id == Team.id)
        .where(
            Team.competition_id == competition_id,
            TeamMember.discord_user_id == discord_user_id,
            TeamMember.status.in_(["pending", "approved"]),
        )
    )
    row = result.first()
    if row is None:
        return None
    member, team = row[0], row[1]
    return team, member


# ── 0-A. 내 소속 팀 조회 ───────────────────────────────────

@router.get("/teams/my")
async def get_my_team(
    discord_user_id: str = Query(...),
    competition_id: UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotMyTeamResponse:
    """discord_user_id로 해당 대회에서 소속 팀을 조회한다."""
    team_info = await _find_team_by_discord_id(db, competition_id, discord_user_id)
    if team_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 유저가 어떤 팀에도 소속되지 않았습니다.",
        )
    team, member = team_info
    return BotMyTeamResponse(
        team_id=team.id,
        team_name=team.name,
        team_code=team.team_code,
        role=member.role,
        member_status=member.status,
        captain_discord_id=team.captain_discord_id,
    )


# ── 0-B. 팀 목록 조회 ─────────────────────────────────────

@router.get("/teams")
async def list_teams(
    competition_id: UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotTeamListResponse:
    """대회별 전체 팀 목록을 조회한다 (/team list 명령)."""
    comp = await _get_competition_or_404(db, competition_id)

    # 팀 목록 조회
    teams_result = await db.execute(
        select(Team).where(Team.competition_id == comp.id).order_by(Team.created_at.asc())
    )
    teams = teams_result.scalars().all()

    items = []
    for t in teams:
        # 팀별 멤버 수 (pending + approved)
        count = (await db.execute(
            select(func.count()).select_from(TeamMember).where(
                TeamMember.team_id == t.id,
                TeamMember.status.in_(["pending", "approved"]),
            )
        )).scalar_one()
        items.append(BotTeamListItem(
            id=t.id,
            name=t.name,
            team_code=t.team_code,
            status=t.status,
            member_count=count,
            max_members=comp.max_members_per_team,
        ))

    return BotTeamListResponse(
        teams=items,
        total=len(items),
        max_teams=comp.max_teams,
    )


# ── 1. 팀 생성 ──────────────────────────────────────────

@router.post("/teams", status_code=status.HTTP_201_CREATED)
async def create_team(
    body: BotTeamCreateRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotTeamCreateResponse:
    """봇에서 팀을 생성한다 (/team create 명령)."""
    comp = await _get_competition_or_404(db, body.competition_id)

    # 대회가 등록 기간인지 확인
    if comp.status != "registration":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="대회가 등록 기간이 아닙니다. (현재 상태: {})".format(comp.status),
        )

    # 최대 팀 수 확인
    team_count = (await db.execute(
        select(func.count()).select_from(Team).where(Team.competition_id == comp.id)
    )).scalar_one()
    if team_count >= comp.max_teams:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="대회 최대 팀 수({})를 초과했습니다.".format(comp.max_teams),
        )

    # 같은 대회에 동일 팀명 중복 확인
    existing_name = (await db.execute(
        select(Team.id).where(Team.competition_id == comp.id, Team.name == body.name)
    )).scalar_one_or_none()
    if existing_name is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="같은 대회에 동일한 팀명이 이미 존재합니다.",
        )

    # 해당 유저가 이미 다른 팀의 팀장인지 확인
    existing_captain = (await db.execute(
        select(Team.id).where(
            Team.competition_id == comp.id,
            Team.captain_discord_id == body.captain_discord_id,
        )
    )).scalar_one_or_none()
    if existing_captain is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="해당 유저가 이미 다른 팀의 팀장입니다.",
        )

    # 팀 코드 생성 (중복 시 재시도)
    for _ in range(10):
        team_code = _generate_team_code(body.name)
        dup = (await db.execute(
            select(Team.id).where(Team.competition_id == comp.id, Team.team_code == team_code)
        )).scalar_one_or_none()
        if dup is None:
            break
    else:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="팀 코드 생성에 실패했습니다. 다시 시도해주세요.",
        )

    team = Team(
        competition_id=comp.id,
        name=body.name,
        team_code=team_code,
        captain_discord_id=body.captain_discord_id,
        status="pending",
    )
    db.add(team)
    await db.flush()

    # 팀장을 멤버로 자동 등록 (approved 상태)
    captain_member = TeamMember(
        team_id=team.id,
        discord_user_id=body.captain_discord_id,
        discord_username=body.captain_discord_username,
        role="captain",
        status="approved",
        joined_at=datetime.now(timezone.utc),
    )
    db.add(captain_member)
    await db.flush()

    await record_bot_audit(
        db, "bot.team.create",
        target_type="team", target_id=team.id,
        details={"team_name": body.name, "captain_discord_id": body.captain_discord_id},
    )

    return BotTeamCreateResponse(
        id=team.id,
        name=team.name,
        team_code=team.team_code,
        captain_discord_id=team.captain_discord_id,
        status=team.status,
        message="팀이 생성되었습니다. 팀 코드: {}".format(team.team_code),
    )


# ── 2. 팀 참가 신청 ─────────────────────────────────────

@router.post("/teams/{code}/join")
async def join_team(
    code: str,
    body: BotTeamJoinRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotTeamJoinResponse:
    """팀에 참가를 신청한다 (/team join 명령)."""
    # 팀 코드로 팀 조회
    result = await db.execute(select(Team).where(Team.team_code == code))
    team = result.scalar_one_or_none()
    if team is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 팀 코드의 팀을 찾을 수 없습니다.",
        )

    # 이미 해당 팀에 가입 신청/가입된 상태인지 확인
    existing_in_team = (await db.execute(
        select(TeamMember.id).where(
            TeamMember.team_id == team.id,
            TeamMember.discord_user_id == body.discord_user_id,
            TeamMember.status.in_(["pending", "approved"]),
        )
    )).scalar_one_or_none()
    if existing_in_team is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 해당 팀에 참가 신청했거나 소속되어 있습니다.",
        )

    # 같은 대회 내 다른 팀 소속 여부 확인
    existing_other = (await db.execute(
        select(TeamMember.id)
        .join(Team, TeamMember.team_id == Team.id)
        .where(
            Team.competition_id == team.competition_id,
            TeamMember.discord_user_id == body.discord_user_id,
            TeamMember.status.in_(["pending", "approved"]),
        )
    )).scalar_one_or_none()
    if existing_other is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 같은 대회의 다른 팀에 소속되어 있습니다.",
        )

    # 팀 최대 인원 초과 확인
    comp = await _get_competition_or_404(db, team.competition_id)
    current_count = (await db.execute(
        select(func.count()).select_from(TeamMember).where(
            TeamMember.team_id == team.id,
            TeamMember.status.in_(["pending", "approved"]),
        )
    )).scalar_one()
    if current_count >= comp.max_members_per_team:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="팀 최대 인원({})을 초과했습니다.".format(comp.max_members_per_team),
        )

    member = TeamMember(
        team_id=team.id,
        discord_user_id=body.discord_user_id,
        discord_username=body.discord_username,
        role="member",
        status="pending",
    )
    db.add(member)
    await db.flush()

    await record_bot_audit(
        db, "bot.member.join",
        target_type="team", target_id=team.id,
        details={"discord_user_id": body.discord_user_id, "team_name": team.name},
    )

    return BotTeamJoinResponse(
        team_id=team.id,
        team_name=team.name,
        member_id=member.id,
        status=member.status,
        message="{} 팀에 참가 신청했습니다. 팀장 승인을 기다려주세요.".format(team.name),
    )


# ── 3. 팀원 승인 ────────────────────────────────────────

@router.post("/teams/{team_id}/approve")
async def approve_member(
    team_id: UUID,
    body: BotCaptainActionRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotMemberActionResponse:
    """팀원 참가를 승인한다 (/team approve 명령)."""
    team = await _get_team_or_404(db, team_id)

    # 요청자가 팀장인지 확인
    if team.captain_discord_id != body.captain_discord_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="팀장만 팀원을 승인할 수 있습니다.",
        )

    # 대상 멤버 조회
    result = await db.execute(
        select(TeamMember).where(
            TeamMember.team_id == team.id,
            TeamMember.discord_user_id == body.target_discord_id,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 팀원을 찾을 수 없습니다.",
        )

    if member.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="대상이 대기(pending) 상태가 아닙니다. (현재: {})".format(member.status),
        )

    now = datetime.now(timezone.utc)
    member.status = "approved"
    member.joined_at = now
    await db.flush()

    await record_bot_audit(
        db, "bot.member.approve",
        target_type="team", target_id=team.id,
        details={"target_discord_id": body.target_discord_id, "team_name": team.name},
    )

    return BotMemberActionResponse(
        member_id=member.id,
        discord_username=member.discord_username,
        status="approved",
        joined_at=member.joined_at,
        message="{} 님이 팀에 합류했습니다.".format(member.discord_username or body.target_discord_id),
    )


# ── 4. 팀원 거절 ────────────────────────────────────────

@router.post("/teams/{team_id}/reject")
async def reject_member(
    team_id: UUID,
    body: BotCaptainActionRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotMemberActionResponse:
    """팀원 참가를 거절한다 (/team reject 명령)."""
    team = await _get_team_or_404(db, team_id)

    if team.captain_discord_id != body.captain_discord_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="팀장만 팀원을 거절할 수 있습니다.",
        )

    result = await db.execute(
        select(TeamMember).where(
            TeamMember.team_id == team.id,
            TeamMember.discord_user_id == body.target_discord_id,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 팀원을 찾을 수 없습니다.",
        )

    if member.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="대상이 대기(pending) 상태가 아닙니다. (현재: {})".format(member.status),
        )

    member.status = "rejected"
    await db.flush()

    await record_bot_audit(
        db, "bot.member.reject",
        target_type="team", target_id=team.id,
        details={"target_discord_id": body.target_discord_id, "team_name": team.name},
    )

    return BotMemberActionResponse(
        member_id=member.id,
        discord_username=member.discord_username,
        status="rejected",
        message="{} 님의 참가 신청이 거절되었습니다.".format(member.discord_username or body.target_discord_id),
    )


# ── 5. 팀원 추방 ────────────────────────────────────────

@router.post("/teams/{team_id}/kick")
async def kick_member(
    team_id: UUID,
    body: BotCaptainActionRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotMemberActionResponse:
    """팀원을 추방한다 (/team kick 명령)."""
    team = await _get_team_or_404(db, team_id)

    if team.captain_discord_id != body.captain_discord_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="팀장만 팀원을 추방할 수 있습니다.",
        )

    # 자기 자신 추방 방지
    if body.captain_discord_id == body.target_discord_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="자기 자신을 추방할 수 없습니다.",
        )

    result = await db.execute(
        select(TeamMember).where(
            TeamMember.team_id == team.id,
            TeamMember.discord_user_id == body.target_discord_id,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 팀원을 찾을 수 없습니다.",
        )

    if member.status != "approved":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="대상이 승인(approved) 상태가 아닙니다. (현재: {})".format(member.status),
        )

    member.status = "kicked"
    await db.flush()

    await record_bot_audit(
        db, "bot.member.kick",
        target_type="team", target_id=team.id,
        details={"target_discord_id": body.target_discord_id, "team_name": team.name},
    )

    return BotMemberActionResponse(
        member_id=member.id,
        discord_username=member.discord_username,
        status="kicked",
        message="{} 님이 팀에서 추방되었습니다.".format(member.discord_username or body.target_discord_id),
    )


# ── 6. 팀 탈퇴 ──────────────────────────────────────────

@router.post("/teams/{team_id}/leave")
async def leave_team(
    team_id: UUID,
    body: BotTeamLeaveRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotMemberActionResponse:
    """팀에서 탈퇴한다 (/team leave 명령)."""
    team = await _get_team_or_404(db, team_id)

    # 팀장은 탈퇴 불가
    if team.captain_discord_id == body.discord_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="팀장은 탈퇴할 수 없습니다. 팀 삭제만 가능합니다.",
        )

    # 대회 진행 중 탈퇴 불가
    comp = await _get_competition_or_404(db, team.competition_id)
    if comp.status in ("running", "paused"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="대회 진행 중에는 탈퇴할 수 없습니다.",
        )

    result = await db.execute(
        select(TeamMember).where(
            TeamMember.team_id == team.id,
            TeamMember.discord_user_id == body.discord_user_id,
            TeamMember.status.in_(["pending", "approved"]),
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 유저가 팀에 소속되어 있지 않습니다.",
        )

    member.status = "left"
    await db.flush()

    await record_bot_audit(
        db, "bot.member.leave",
        target_type="team", target_id=team.id,
        details={"discord_user_id": body.discord_user_id, "team_name": team.name},
    )

    return BotMemberActionResponse(
        member_id=member.id,
        discord_username=member.discord_username,
        status="left",
        message="팀에서 탈퇴했습니다.",
    )


# ── 7. 팀 삭제 ──────────────────────────────────────────

@router.delete("/teams/{team_id}")
async def delete_team(
    team_id: UUID,
    body: BotTeamDeleteRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotTeamDeleteResponse:
    """팀을 삭제한다 (/team delete 명령). 대회 시작 전에만 가능."""
    team = await _get_team_or_404(db, team_id)

    if team.captain_discord_id != body.captain_discord_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="팀장만 팀을 삭제할 수 있습니다.",
        )

    comp = await _get_competition_or_404(db, team.competition_id)
    if comp.status in ("running", "paused"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="대회가 이미 시작되어 팀을 삭제할 수 없습니다.",
        )

    team_name = team.name

    await record_bot_audit(
        db, "bot.team.delete",
        target_type="team", target_id=team.id,
        details={"team_name": team_name, "captain_discord_id": body.captain_discord_id},
    )

    # 팀 멤버 먼저 삭제 (CASCADE이므로 DB에서 처리되지만 명시적으로)
    await db.execute(
        select(TeamMember).where(TeamMember.team_id == team.id)
    )
    await db.delete(team)
    await db.flush()

    return BotTeamDeleteResponse(
        team_id=team_id,
        team_name=team_name,
        message="팀이 삭제되었습니다.",
    )


# ── 8. 팀 정보 조회 ─────────────────────────────────────

@router.get("/teams/{team_id}")
async def get_team_info(
    team_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotTeamInfoResponse:
    """팀 정보를 조회한다 (/team info 명령)."""
    team = await _get_team_or_404(db, team_id)

    # 멤버 목록 조회
    members_result = await db.execute(
        select(TeamMember).where(
            TeamMember.team_id == team.id,
            TeamMember.status.in_(["pending", "approved"]),
        )
    )
    members = members_result.scalars().all()

    member_items = [
        BotTeamMemberInfo(
            discord_username=m.discord_username,
            role=m.role,
            status=m.status,
        )
        for m in members
    ]

    return BotTeamInfoResponse(
        id=team.id,
        name=team.name,
        team_code=team.team_code,
        status=team.status,
        member_count=len(member_items),
        members=member_items,
    )


# ── 9. 플래그 제출 ──────────────────────────────────────

@router.post("/flags/submit")
async def submit_flag(
    body: BotFlagSubmitRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotFlagSubmitResponse:
    """플래그를 제출한다 (/flag 명령).

    검증 순서:
    1. 대회 결정 (body.competition_id 또는 running 상태 대회 자동 선택)
    2. 제출자의 소속 팀 조회
    3. 플래그 형식 검증 (FLAG{...})
    4. flags 테이블에서 flag_value 매칭
    5. 자기 팀 플래그인지 확인 (own_flag)
    6. 이미 제출한 플래그인지 확인 (duplicate)
    7. 만료된 플래그인지 확인 (expired)
    8. 통과 시 correct로 기록
    """
    # 1. 대회 결정 — competition_id가 오면 그 대회 사용, 아니면 현재 running 대회 자동 선택
    if body.competition_id is not None:
        comp = await _get_competition_or_404(db, body.competition_id)
        if comp.status != "running":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="대회가 진행 중(running) 상태가 아닙니다. (현재: {})".format(comp.status),
            )
    else:
        running_result = await db.execute(
            select(Competition).where(Competition.status == "running").order_by(Competition.actual_start_at.desc()).limit(1)
        )
        comp = running_result.scalar_one_or_none()
        if comp is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="현재 진행 중(running) 상태인 대회가 없습니다.",
            )

    # 2. 제출자 소속 팀 조회
    team_info = await _find_team_by_discord_id(db, comp.id, body.discord_user_id)
    if team_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="제출자가 어떤 팀에도 소속되지 않았습니다.",
        )
    submitter_team, _submitter_member = team_info

    # 3. 플래그 형식 검증
    if not FLAG_PATTERN.match(body.submitted_flag):
        submission = FlagSubmission(
            competition_id=comp.id,
            submitter_team_id=submitter_team.id,
            submitted_flag=body.submitted_flag,
            verdict="invalid_format",
            submitter_discord_id=body.discord_user_id,
        )
        db.add(submission)
        await db.flush()
        await record_bot_audit(
            db, "bot.flag.submit",
            target_type="flag", target_id=submission.id,
            details={
                "discord_user_id": body.discord_user_id,
                "verdict": submission.verdict,
            },
        )
        return BotFlagSubmitResponse(
            submission_id=submission.id,
            verdict="invalid_format",
            message="플래그 형식이 올바르지 않습니다. FLAG{...} 형식으로 제출해주세요.",
        )

    # 4. flags 테이블에서 매칭
    flag_result = await db.execute(
        select(Flag).where(Flag.flag_value == body.submitted_flag)
    )
    matched_flag = flag_result.scalar_one_or_none()

    if matched_flag is None:
        # 형식은 맞지만 존재하지 않는 플래그
        submission = FlagSubmission(
            competition_id=comp.id,
            submitter_team_id=submitter_team.id,
            submitted_flag=body.submitted_flag,
            verdict="incorrect",
            submitter_discord_id=body.discord_user_id,
        )
        db.add(submission)
        await db.flush()
        await record_bot_audit(
            db, "bot.flag.submit",
            target_type="flag", target_id=submission.id,
            details={
                "discord_user_id": body.discord_user_id,
                "verdict": submission.verdict,
            },
        )
        return BotFlagSubmitResponse(
            submission_id=submission.id,
            verdict="incorrect",
            message="오답입니다. 유효하지 않은 플래그입니다.",
        )

    # 5. 자기 팀 플래그인지 확인
    if matched_flag.team_id == submitter_team.id:
        submission = FlagSubmission(
            competition_id=comp.id,
            round_id=matched_flag.round_id,
            submitter_team_id=submitter_team.id,
            target_team_id=matched_flag.team_id,
            service_id=matched_flag.service_id,
            submitted_flag=body.submitted_flag,
            flag_id=matched_flag.id,
            verdict="own_flag",
            submitter_discord_id=body.discord_user_id,
        )
        db.add(submission)
        await db.flush()
        await record_bot_audit(
            db, "bot.flag.submit",
            target_type="flag", target_id=submission.id,
            details={
                "discord_user_id": body.discord_user_id,
                "verdict": submission.verdict,
            },
        )
        return BotFlagSubmitResponse(
            submission_id=submission.id,
            verdict="own_flag",
            message="자기 팀의 플래그는 제출할 수 없습니다.",
        )

    # 6. 이미 제출한 플래그인지 확인 (같은 팀이 같은 flag_id를 correct로 제출)
    dup_result = await db.execute(
        select(FlagSubmission.id).where(
            FlagSubmission.submitter_team_id == submitter_team.id,
            FlagSubmission.flag_id == matched_flag.id,
            FlagSubmission.verdict == "correct",
        )
    )
    if dup_result.scalar_one_or_none() is not None:
        submission = FlagSubmission(
            competition_id=comp.id,
            round_id=matched_flag.round_id,
            submitter_team_id=submitter_team.id,
            target_team_id=matched_flag.team_id,
            service_id=matched_flag.service_id,
            submitted_flag=body.submitted_flag,
            flag_id=matched_flag.id,
            verdict="duplicate",
            submitter_discord_id=body.discord_user_id,
        )
        db.add(submission)
        await db.flush()
        await record_bot_audit(
            db, "bot.flag.submit",
            target_type="flag", target_id=submission.id,
            details={
                "discord_user_id": body.discord_user_id,
                "verdict": submission.verdict,
            },
        )
        return BotFlagSubmitResponse(
            submission_id=submission.id,
            verdict="duplicate",
            message="이미 제출한 플래그입니다.",
        )

    # 7. 만료된 플래그인지 확인
    now = datetime.now(timezone.utc)
    if matched_flag.expires_at is not None and matched_flag.expires_at < now:
        submission = FlagSubmission(
            competition_id=comp.id,
            round_id=matched_flag.round_id,
            submitter_team_id=submitter_team.id,
            target_team_id=matched_flag.team_id,
            service_id=matched_flag.service_id,
            submitted_flag=body.submitted_flag,
            flag_id=matched_flag.id,
            verdict="expired",
            submitter_discord_id=body.discord_user_id,
        )
        db.add(submission)
        await db.flush()
        await record_bot_audit(
            db, "bot.flag.submit",
            target_type="flag", target_id=submission.id,
            details={
                "discord_user_id": body.discord_user_id,
                "verdict": submission.verdict,
            },
        )
        return BotFlagSubmitResponse(
            submission_id=submission.id,
            verdict="expired",
            message="만료된 플래그입니다. 현재 라운드의 플래그를 제출해주세요.",
        )

    # 비활성 플래그 체크
    if not matched_flag.is_active:
        submission = FlagSubmission(
            competition_id=comp.id,
            round_id=matched_flag.round_id,
            submitter_team_id=submitter_team.id,
            target_team_id=matched_flag.team_id,
            service_id=matched_flag.service_id,
            submitted_flag=body.submitted_flag,
            flag_id=matched_flag.id,
            verdict="expired",
            submitter_discord_id=body.discord_user_id,
        )
        db.add(submission)
        await db.flush()
        await record_bot_audit(
            db, "bot.flag.submit",
            target_type="flag", target_id=submission.id,
            details={
                "discord_user_id": body.discord_user_id,
                "verdict": submission.verdict,
            },
        )
        return BotFlagSubmitResponse(
            submission_id=submission.id,
            verdict="expired",
            message="만료된 플래그입니다. 현재 라운드의 플래그를 제출해주세요.",
        )

    # 8. 정답 처리
    submission = FlagSubmission(
        competition_id=comp.id,
        round_id=matched_flag.round_id,
        submitter_team_id=submitter_team.id,
        target_team_id=matched_flag.team_id,
        service_id=matched_flag.service_id,
        submitted_flag=body.submitted_flag,
        flag_id=matched_flag.id,
        verdict="correct",
        submitter_discord_id=body.discord_user_id,
    )
    db.add(submission)
    await db.flush()

    # 대상 팀명, 서비스명 조회
    target_team = (await db.execute(
        select(Team.name).where(Team.id == matched_flag.team_id)
    )).scalar_one_or_none() or "알 수 없음"

    service_name = (await db.execute(
        select(VulnService.name).where(VulnService.id == matched_flag.service_id)
    )).scalar_one_or_none() or "알 수 없음"

    await record_bot_audit(
        db, "bot.flag.submit",
        target_type="flag", target_id=submission.id,
        details={
            "discord_user_id": body.discord_user_id,
            "verdict": submission.verdict,
        },
    )

    return BotFlagSubmitResponse(
        submission_id=submission.id,
        verdict="correct",
        message="정답! {} 팀이 {} 팀의 {} 플래그를 탈취했습니다.".format(
            submitter_team.name, target_team, service_name,
        ),
        details=BotFlagSubmitDetails(
            target_team=target_team,
            service=service_name,
        ),
    )


# ── 10. 점수 조회 ───────────────────────────────────────

@router.get("/scores")
async def get_scores(
    competition_id: UUID = Query(...),
    discord_user_id: str | None = Query(default=None),
    top: int = Query(default=10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotScoreResponse:
    """현재 순위를 조회한다 (/score 명령)."""
    comp = await _get_competition_or_404(db, competition_id)

    # 최신 라운드 조회
    latest_round_result = await db.execute(
        select(ScoringRound)
        .where(
            ScoringRound.competition_id == comp.id,
            ScoringRound.status == "completed",
        )
        .order_by(ScoringRound.round_number.desc())
        .limit(1)
    )
    latest_round = latest_round_result.scalar_one_or_none()
    if latest_round is None:
        return BotScoreResponse(round_number=0, rankings=[])

    # 요청자 소속 팀 조회 (선택)
    my_team_id = None
    if discord_user_id:
        team_info = await _find_team_by_discord_id(db, comp.id, discord_user_id)
        if team_info is not None:
            my_team_id = team_info[0].id

    # 해당 라운드 점수 조회
    scores_result = await db.execute(
        select(TeamScore, Team.name)
        .join(Team, TeamScore.team_id == Team.id)
        .where(TeamScore.round_id == latest_round.id)
        .order_by(TeamScore.rank.asc().nulls_last(), TeamScore.total_score.desc())
        .limit(top)
    )
    rows = scores_result.all()

    rankings = []
    my_team_score = None

    for score, team_name in rows:
        is_mine = my_team_id is not None and score.team_id == my_team_id
        rankings.append(BotRankingItem(
            rank=score.rank,
            team_name=team_name,
            total_score=score.total_score,
            is_my_team=is_mine,
        ))
        if is_mine:
            # SLA 백분율 계산 (0~1 → 0~100)
            sla_pct = float(score.sla_score) * 100 if score.sla_score else 0.0
            my_team_score = BotMyTeamScore(
                rank=score.rank,
                team_name=team_name,
                total_score=score.total_score,
                attack_score=score.attack_score,
                defense_score=score.defense_score,
                sla_percentage=round(sla_pct, 1),
            )

    # 내 팀이 top N 안에 없는 경우 별도 조회
    if my_team_id is not None and my_team_score is None:
        my_result = await db.execute(
            select(TeamScore, Team.name)
            .join(Team, TeamScore.team_id == Team.id)
            .where(
                TeamScore.round_id == latest_round.id,
                TeamScore.team_id == my_team_id,
            )
        )
        my_row = my_result.first()
        if my_row is not None:
            score, team_name = my_row
            sla_pct = float(score.sla_score) * 100 if score.sla_score else 0.0
            my_team_score = BotMyTeamScore(
                rank=score.rank,
                team_name=team_name,
                total_score=score.total_score,
                attack_score=score.attack_score,
                defense_score=score.defense_score,
                sla_percentage=round(sla_pct, 1),
            )

    return BotScoreResponse(
        round_number=latest_round.round_number,
        rankings=rankings,
        my_team=my_team_score,
    )


# ── 11. 서비스 상태 조회 ────────────────────────────────

@router.get("/status/{discord_id}")
async def get_service_status(
    discord_id: str,
    competition_id: UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotStatusResponse:
    """내 팀 서비스 상태를 조회한다 (/status 명령)."""
    comp = await _get_competition_or_404(db, competition_id)

    team_info = await _find_team_by_discord_id(db, comp.id, discord_id)
    if team_info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="해당 디스코드 유저가 어떤 팀에도 소속되지 않았습니다.",
        )
    team, _member = team_info

    # 팀에 배포된 서비스 목록과 최신 SLA 정보 조회
    services_result = await db.execute(
        select(TeamService, VulnService.name)
        .join(VulnService, TeamService.service_id == VulnService.id)
        .where(TeamService.team_id == team.id)
    )
    team_services = services_result.all()

    if not team_services:
        return BotStatusResponse(
            team_id=team.id,
            team_name=team.name,
            services=[],
            overall_sla=0.0,
        )

    service_items = []
    sla_sum = 0.0

    for ts, svc_name in team_services:
        # 해당 서비스의 전체 SLA 체크 기록에서 UP 비율 계산
        total_checks = (await db.execute(
            select(func.count()).select_from(SlaCheck).where(
                SlaCheck.team_id == team.id,
                SlaCheck.service_id == ts.service_id,
            )
        )).scalar_one()

        up_checks = 0
        sla_pct = 0.0
        if total_checks > 0:
            up_checks = (await db.execute(
                select(func.count()).select_from(SlaCheck).where(
                    SlaCheck.team_id == team.id,
                    SlaCheck.service_id == ts.service_id,
                    SlaCheck.is_up.is_(True),
                )
            )).scalar_one()
            sla_pct = round((up_checks / total_checks) * 100, 1)

        sla_sum += sla_pct
        service_items.append(BotServiceStatusItem(
            service_name=svc_name,
            is_up=ts.last_health_check_result or False,
            sla_percentage=sla_pct,
            last_check_at=ts.last_health_check_at,
        ))

    overall = round(sla_sum / len(service_items), 1) if service_items else 0.0

    return BotStatusResponse(
        team_id=team.id,
        team_name=team.name,
        services=service_items,
        overall_sla=overall,
    )


# ── 12. 티켓 생성 ───────────────────────────────────────

@router.post("/tickets", status_code=status.HTTP_201_CREATED)
async def create_ticket(
    body: BotTicketCreateRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotTicketCreateResponse:
    """이의 제기/신고 티켓을 생성한다 (/ticket 명령)."""
    await _get_competition_or_404(db, body.competition_id)

    # 티켓 번호 생성: CS-{년도}-{순번}
    year = datetime.now(timezone.utc).year
    last_ticket = (await db.execute(
        select(func.count()).select_from(Ticket)
    )).scalar_one()
    ticket_number = "CS-{}-{:03d}".format(year, last_ticket + 1)

    ticket = Ticket(
        ticket_number=ticket_number,
        type=body.type,
        title=body.title,
        description=body.description,
        team_id=str(body.team_id) if body.team_id else None,
        team_name=body.team_name,
        reporter_type="discord",
        reporter_id=body.discord_user_id,
        status="open",
        priority="medium",
    )
    db.add(ticket)
    await db.flush()

    await record_bot_audit(
        db, "bot.ticket.create",
        target_type="ticket", target_id=ticket.id,
        details={"discord_user_id": body.discord_user_id, "title": body.title},
    )

    return BotTicketCreateResponse(
        ticket_id=ticket.id,
        ticket_number=ticket.ticket_number,
        status="open",
        message="티켓이 접수되었습니다. 티켓 번호: {}".format(ticket.ticket_number),
    )


# ── 13. 피드백 제출 ─────────────────────────────────────

@router.post("/feedbacks", status_code=status.HTTP_201_CREATED)
async def create_feedback(
    body: BotFeedbackCreateRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> BotFeedbackCreateResponse:
    """대회 후 피드백을 제출한다 (/feedback 명령)."""
    comp = await _get_competition_or_404(db, body.competition_id)

    # 대회 상태 확인 (finished 또는 archived에서만 피드백 가능)
    if comp.status not in ("finished", "archived"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="대회가 종료(finished) 또는 아카이브(archived) 상태가 아닙니다. (현재: {})".format(comp.status),
        )

    # 중복 피드백 확인 (대회당 1인 1피드백)
    existing = (await db.execute(
        select(Feedback.id).where(
            Feedback.competition_id == comp.id,
            Feedback.discord_user_id == body.discord_user_id,
        )
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 해당 대회에 피드백을 제출했습니다.",
        )

    feedback = Feedback(
        competition_id=comp.id,
        discord_user_id=body.discord_user_id,
        discord_username=body.discord_username,
        team_id=body.team_id,
        rating=body.rating,
        content=body.content,
        category=body.category,
    )
    db.add(feedback)
    await db.flush()

    await record_bot_audit(
        db, "bot.feedback.create",
        target_type="feedback", target_id=feedback.id,
        details={"discord_user_id": body.discord_user_id, "category": body.category},
    )

    return BotFeedbackCreateResponse(
        id=feedback.id,
        rating=feedback.rating,
        category=feedback.category,
        message="피드백이 제출되었습니다. 참여해 주셔서 감사합니다!",
    )


# ── 14. 봇 설정 조회 (DB에서) ─────────────────────────────

_DISCORD_CONFIG_KEYS = [
    "discord_bot_token",
    "discord_guild_id",
    "discord_announcement_channel_id",
    "discord_emergency_channel_id",
    "discord_ticket_channel_id",
    "discord_admin_role_id",
    "bot_api_base_url",
    "bot_api_key",
]


@router.get("/config/discord")
async def get_discord_config_for_bot(
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_bot_api_key),
) -> dict[str, str]:
    """봇이 DB에서 디스코드 설정을 가져가는 전용 엔드포인트.

    프론트엔드용 /api/settings/discord와 달리 마스킹 없이 원본 값을 반환한다.
    X-Bot-API-Key 인증 필수.
    """
    result = await db.execute(
        select(CompetitionConfig).where(
            CompetitionConfig.key.in_(_DISCORD_CONFIG_KEYS)
        )
    )
    configs = {cfg.key: cfg.value for cfg in result.scalars().all()}

    response: dict[str, str] = {}
    for key in _DISCORD_CONFIG_KEYS:
        raw = configs.get(key, "")
        response[key] = str(raw) if raw else ""

    return response
