from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Redis
    REDIS_URL: str = "redis://localhost:6379/1"

    # 인증
    INTERNAL_API_KEY: str = "cstrike-internal-2026"

    # ops-backend 콜백
    OPS_BACKEND_URL: str = "http://ops-backend:8400"

    # MinIO
    MINIO_ENDPOINT: str = "minio:9000"
    MINIO_ACCESS_KEY: str = "cstrike"
    MINIO_SECRET_KEY: str = "cstrike_secret"
    MINIO_BUCKET: str = "cstrike-builds"
    MINIO_SECURE: bool = False

    # Docker
    DOCKER_HOST: str = "unix:///var/run/docker.sock"

    # 빌드 제한
    BUILD_TIMEOUT_SECONDS: int = 300  # 5분
    DEPLOY_MAX_CONCURRENT: int = 5

    # SSH 원격 배포
    SSH_CONNECT_TIMEOUT: int = 15
    SSH_COMMAND_TIMEOUT: int = 60
    SSH_TRANSFER_TIMEOUT: int = 600  # 이미지 전송 최대 10분

    model_config = {"env_file": ".env"}


settings = Settings()
