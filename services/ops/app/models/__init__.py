"""모든 SQLAlchemy 모델을 한곳에서 import한다.

Alembic 마이그레이션 및 앱 초기화 시 이 모듈을 통해 모든 테이블이 등록된다.
"""

from app.models.audit import OpsAuditLog
from app.models.competition import Competition
from app.models.config import CompetitionConfig
from app.models.discord_member import DiscordGuildMember
from app.models.deploy import DeployPipeline, DeployStage
from app.models.emergency import EmergencyAction
from app.models.feedback import Feedback
from app.models.flag import Flag, FlagSubmission
from app.models.operator import Operator
from app.models.scoring_round import ScoringRound
from app.models.sla_check import SlaCheck
from app.models.team import Team, TeamMember
from app.models.team_score import TeamScore
from app.models.team_service import TeamService
from app.models.ticket import Ticket, TicketMessage
from app.models.vuln_service import VulnService
from app.models.vulnpack import VulnpackSchedule

__all__ = [
    "Competition",
    "CompetitionConfig",
    "DiscordGuildMember",
    "DeployPipeline",
    "DeployStage",
    "EmergencyAction",
    "Feedback",
    "Flag",
    "FlagSubmission",
    "Operator",
    "OpsAuditLog",
    "ScoringRound",
    "SlaCheck",
    "Team",
    "TeamMember",
    "TeamScore",
    "TeamService",
    "Ticket",
    "TicketMessage",
    "VulnService",
    "VulnpackSchedule",
]
