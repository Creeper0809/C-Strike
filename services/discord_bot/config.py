# config.py
import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"
load_dotenv(dotenv_path=ENV_PATH)


def _normalize_env_file(path: Path) -> None:
    """Support .env files saved with UTF-8 BOM by re-exporting normalized keys."""
    if not path.exists():
        return

    for key, value in dotenv_values(path).items():
        if key is None:
            continue
        normalized_key = key.lstrip("\ufeff")
        if normalized_key and value is not None and os.getenv(normalized_key) is None:
            os.environ[normalized_key] = value


_normalize_env_file(ENV_PATH)


def _optional_int_env(name: str) -> int | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return int(value)


DISCORD_TOKEN = (os.getenv("DISCORD_TOKEN") or "").strip()
if not DISCORD_TOKEN:
    raise RuntimeError("DISCORD_TOKEN must be set in .env")
GUILD_ID = int(os.getenv("GUILD_ID"))
AUDIT_LOG_CHANNEL_ID = int(os.getenv("AUDIT_LOG_CHANNEL_ID"))
TICKET_CATEGORY_ID = int(os.getenv("TICKET_CATEGORY_ID"))
REGISTER_CHANNEL_ID = _optional_int_env("REGISTER_CHANNEL_ID")
REGISTER_CHANNEL_NAME = os.getenv("REGISTER_CHANNEL_NAME", "register")
BOT_API_URL = os.getenv("BOT_API_URL", "http://127.0.0.1:5000")
BOT_API_BASE_URL = os.getenv("BOT_API_BASE_URL", "http://127.0.0.1:8400/api/v1/bot")
BOT_API_KEY = (os.getenv("BOT_API_KEY") or "").strip()
if not BOT_API_KEY:
    raise RuntimeError("BOT_API_KEY must be set in .env")
BOT_COMPETITION_ID = os.getenv("BOT_COMPETITION_ID", "").strip()
REGISTER_API_URL = os.getenv("REGISTER_API_URL", "http://127.0.0.1:5050/api/v1/auth/discord/start")
REGISTER_API_KEY = os.getenv("REGISTER_API_KEY") or os.getenv("REGISTER_API_SECRET") or BOT_API_KEY
FLAG_API_URL = os.getenv("FLAG_API_URL", "http://ops-backend:8400/api/v1/bot/flags/submit")
FLAG_API_KEY = os.getenv("FLAG_API_KEY") or os.getenv("FLAG_API_SECRET") or REGISTER_API_KEY or BOT_API_KEY
OPERATOR_ROLE_ID = _optional_int_env("OPERATOR_ROLE_ID")
AUTHENTICATED_ROLE_ID = _optional_int_env("AUTHENTICATED_ROLE_ID")
UNAUTHENTICATED_ROLE_ID = _optional_int_env("UNAUTHENTICATED_ROLE_ID")
OPERATOR_ROLE_NAME = os.getenv("OPERATOR_ROLE_NAME", "운영자")
AUTHENTICATED_ROLE_NAME = os.getenv("AUTHENTICATED_ROLE_NAME", "인증된 사용자")
UNAUTHENTICATED_ROLE_NAME = os.getenv("UNAUTHENTICATED_ROLE_NAME", "인증되지 않은 사용자")

# Backward-compatible aliases used by some modules.
BOT_API_SECRET = BOT_API_KEY
REGISTER_API_SECRET = REGISTER_API_KEY

POSTGRES_HOST = os.getenv("POSTGRES_HOST", "postgres")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
POSTGRES_USER = os.getenv("POSTGRES_USER", "cstrike")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "")
POSTGRES_DATABASE = os.getenv("POSTGRES_DATABASE") or os.getenv("POSTGRES_DB", "cstrike")
POSTGRES_SCHEMA = os.getenv("POSTGRES_SCHEMA", "cstrike")

