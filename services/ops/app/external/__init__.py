"""외부 시스템 클라이언트 모듈."""
from app.external.cguard import CGuardClient
from app.external.scoring import ScoringClient
from app.external.containers import ContainerClient
from app.external.scoreboard import ScoreboardClient
from app.external.discord_bot import DiscordBotClient
from app.config import settings

cguard_client = CGuardClient(settings.CGUARD_SERVER_URL, settings.CGUARD_INTEGRATION_TOKEN)
scoring_client = ScoringClient(settings.SCORING_URL)
container_client = ContainerClient(settings.CONTAINER_MANAGER_URL)
scoreboard_client = ScoreboardClient(settings.SCOREBOARD_URL)
discord_client = DiscordBotClient(
    settings.DISCORD_BOT_URL,
    headers={"api-bot-key": settings.BOT_API_KEY},
)
