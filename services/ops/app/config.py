"""환경변수 설정 모듈."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """애플리케이션 환경변수 설정."""

    # 데이터베이스
    DATABASE_URL: str = "postgresql+asyncpg://ops_svc:ops_password@localhost:5432/ops_db"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # JWT 인증
    JWT_SECRET_KEY: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 480

    # 초기 관리자 계정
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin1234"

    # CORS 허용 오리진 (쉼표 구분)
    ALLOWED_ORIGINS: str = "http://localhost:3000"

    # 디스코드 봇 API Key
    BOT_API_KEY: str = "cstrike-bot-secret-key-change-me"

    # Phase 11: deploy-service 연동
    DEPLOY_SERVICE_URL: str = "http://deploy-service:8450"
    INTERNAL_API_KEY: str = "cstrike-internal-2026"

    # MinIO
    MINIO_ENDPOINT: str = "minio:9000"
    MINIO_ACCESS_KEY: str = "cstrike"
    MINIO_SECRET_KEY: str = "cstrike_secret"
    MINIO_BUCKET: str = "cstrike-builds"

    # 외부 시스템 URL — Docker 내부 서비스명 기준
    SCORING_URL: str = "http://scoring-engine:8460"
    SCOREBOARD_URL: str = "http://scoreboard:8000"
    # C-Guard로 대체됨 (하위호환 유지)
    VANGUARD_URL: str = "http://cguard-server:8500"
    CONTAINER_MANAGER_URL: str = "http://container-manager:8403"
    DISCORD_BOT_URL: str = "http://discord-bot:8405"

    # C-Guard 연동
    CGUARD_SERVER_URL: str = "http://cguard-server:8500"
    CGUARD_INTEGRATION_TOKEN: str = "cguard-integration-token-change-me"

    # SSH 비밀번호 암호화 키 (Fernet, 32바이트 base64)
    SSH_ENCRYPTION_KEY: str = "your-fernet-key-change-in-production"

    model_config = {"env_file": ".env"}


settings = Settings()
