"""채점 엔진 환경변수 설정 모듈.

운영 포털(ops)과 동일한 DB를 사용하되, 환경변수 접두사 SCORING_ 으로 구분한다.
"""

from pydantic_settings import BaseSettings


class ScoringSettings(BaseSettings):
    """채점 엔진 환경변수 설정."""

    # ── 데이터베이스 ──
    DATABASE_URL: str = "postgresql+asyncpg://ops_svc:ops_password@localhost:5432/ops_db"
    DB_POOL_MIN: int = 5
    DB_POOL_MAX: int = 20

    # ── Redis ──
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_EVENT_BUFFER_MAX: int = 1000  # Redis 끊김 시 버퍼 최대 크기

    # ── 라운드 설정 (None이면 DB competitions 테이블 값 사용) ──
    ROUND_INTERVAL_OVERRIDE: int | None = None

    # ── SLA 체크 ──
    SLA_TIMEOUT_SECONDS: int = 10

    # ── 플래그 설정 ──
    FLAG_PLANT_TIMEOUT_SECONDS: int = 5
    FLAG_PLANT_RETRY_COUNT: int = 1
    FLAG_PLANT_RETRY_DELAY_SECONDS: int = 2
    MAX_CONCURRENT_SSH: int = 20
    FLAG_HMAC_SECRET: str = "cstrike-flag-hmac-change-me"

    # ── SSH 설정 ──
    SSH_KEY_PATH: str = "/app/keys/scoring_key"
    SSH_USER: str = "root"
    SSH_ENCRYPTION_KEY: str = ""  # Fernet 키 (ops-backend와 동일)

    # ── 점수 설정 (기본값, DB competition_config 에서 덮어쓸 수 있음) ──
    DEFENSE_WEIGHT: float = 1.0
    SLA_PENALTY_THRESHOLD: float = 0.5
    FLAG_LIFETIME_ROUNDS: int = 2

    # ── 자동 공개용 ops-backend 연동 ──
    OPS_BACKEND_URL: str = "http://ops-backend:8400"
    OPS_INTERNAL_API_KEY: str = "cstrike-internal-2026"

    # ── 로깅 ──
    LOG_LEVEL: str = "INFO"

    model_config = {"env_prefix": "SCORING_", "env_file": ".env"}


settings = ScoringSettings()
