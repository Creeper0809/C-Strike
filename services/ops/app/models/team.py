"""팀(Team, TeamMember) 모델."""

from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class Team(Base):
    """대회 참가 팀. 디스코드 기반 등록/승인 흐름을 지원한다."""

    __tablename__ = "teams"
    __table_args__ = (
        UniqueConstraint("competition_id", "name", name="uq_teams_competition_name"),
        UniqueConstraint("competition_id", "team_code", name="uq_teams_competition_code"),
        CheckConstraint(
            "status IN ('pending', 'approved', 'active', 'disqualified', 'withdrawn')",
            name="chk_teams_status",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    competition_id = Column(UUID(as_uuid=True), ForeignKey("competitions.id", ondelete="RESTRICT"), nullable=False)
    name = Column(String(100), nullable=False)
    team_code = Column(String(10), nullable=False)
    captain_discord_id = Column(String(50), nullable=False)
    discord_role_id = Column(String(50))
    subnet = Column(String(50))
    gateway_ip = Column(String(45))
    vpn_profile_issued = Column(Boolean, nullable=False, default=False)
    status = Column(String(20), nullable=False, default="pending")
    registered_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    approved_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # SSH 원격 배포 접속 정보
    ssh_port = Column(Integer, nullable=False, default=22)
    ssh_user = Column(String(100))
    ssh_password = Column(Text)  # Fernet 암호화 저장


class TeamMember(Base):
    """팀원 레코드. 디스코드 유저 ID 기반으로 식별한다."""

    __tablename__ = "team_members"
    __table_args__ = (
        UniqueConstraint("team_id", "discord_user_id", name="uq_team_members_team_user"),
        CheckConstraint("role IN ('captain', 'member')", name="chk_team_members_role"),
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'left', 'kicked')",
            name="chk_team_members_status",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    discord_user_id = Column(String(50), nullable=False)
    discord_username = Column(String(100))
    role = Column(String(20), nullable=False, default="member")
    status = Column(String(20), nullable=False, default="pending")
    joined_at = Column(DateTime(timezone=True))
    vpn_username = Column(String(128))
    vpn_ip = Column(String(64))
    vpn_password = Column(Text)  # Fernet 암호화 저장
    vpn_password_updated_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
