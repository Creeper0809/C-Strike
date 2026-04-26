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

    # 운영 포털 팀 생성 시 사용할 사전 준비 슬롯 풀(JSON 배열, legacy fallback)
    TEAM_SLOT_POOL_JSON: str = ""
    TEAM_SLOT_INVENTORY_FILENAME: str = "team-slots.csv"
    TEAM_SLOT_DEFAULT_SSH_PORT: int = 22
    TEAM_SLOT_DEFAULT_SSH_USER: str = ""
    TEAM_SLOT_DEFAULT_SSH_PASSWORD: str = ""

    # 라우터 네트워크 자동화 (팀 삭제 시 실제 VPN/iptables 정리)
    NETWORK_TEAM_DELETE_ENABLED: bool = False
    NETWORK_TEAM_DELETE_HOST: str = ""
    NETWORK_TEAM_DELETE_PORT: int = 22
    NETWORK_TEAM_DELETE_USER: str = ""
    NETWORK_TEAM_DELETE_PASSWORD: str = ""
    NETWORK_TEAM_DELETE_ROOT: str = "/home/user/network"
    NETWORK_TEAM_DELETE_USE_SUDO: bool = True
    NETWORK_TEAM_DELETE_TIMEOUT_SECONDS: int = 120
    NETWORK_TEAM_DELETE_EXECUTE_USERS: bool = True
    NETWORK_TEAM_DELETE_PURGE_USERS: bool = False
    NETWORK_TEAM_DELETE_RELEASE_IP: bool = False

    # 라우터 네트워크 자동화 (팀 생성 시 실제 VPN/iptables 생성)
    NETWORK_TEAM_PROVISION_ENABLED: bool = False
    NETWORK_TEAM_PROVISION_HOST: str = ""
    NETWORK_TEAM_PROVISION_PORT: int = 22
    NETWORK_TEAM_PROVISION_USER: str = ""
    NETWORK_TEAM_PROVISION_PASSWORD: str = ""
    NETWORK_TEAM_PROVISION_ROOT: str = "/home/user/network"
    NETWORK_TEAM_PROVISION_USE_SUDO: bool = True
    NETWORK_TEAM_PROVISION_TIMEOUT_SECONDS: int = 120
    NETWORK_TEAM_PROVISION_EXECUTE_USERS: bool = True
    NETWORK_TEAM_PROVISION_REUSE_RETIRED: bool = True
    NETWORK_TEAM_PROVISION_USERS_PER_TEAM: int = 0

    model_config = {"env_file": ".env"}


settings = Settings()
