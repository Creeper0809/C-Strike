from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

from app.config import settings
from app.api import health, build, deploy, containers


@asynccontextmanager
async def lifespan(app: FastAPI):
    """시작 시 MinIO 버킷 자동 생성"""
    try:
        from app.minio_client import ensure_bucket
        ensure_bucket()
    except Exception as e:
        print(f"[경고] MinIO 버킷 초기화 실패: {e}")
    yield


app = FastAPI(
    title="C-Strike Deploy Service",
    description="Docker 컨테이너 빌드/배포/관리 서비스",
    version="1.0.0",
    lifespan=lifespan,
)


def verify_api_key(request: Request):
    """내부 API 키 검증"""
    api_key = request.headers.get("X-Internal-API-Key")
    if api_key != settings.INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="유효하지 않은 API 키")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    try:
        verify_api_key(request)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"detail": e.detail})
    return await call_next(request)


app.include_router(health.router)
app.include_router(build.router)
app.include_router(deploy.router)
app.include_router(containers.router)
