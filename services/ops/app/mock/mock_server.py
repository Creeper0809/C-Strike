"""Mock 서버 -- 5개 외부 시스템 API를 단일 앱에서 제공."""
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.mock.routers import containers, discord_bot, scoreboard, scoring, vanguard
from app.mock.state import reset_state


@asynccontextmanager
async def lifespan(app: FastAPI):
    reset_state()
    yield


app = FastAPI(
    title="C-STRIKE Mock 외부 시스템",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(vanguard.router, prefix="/api/vanguard", tags=["뱅가드"])
app.include_router(scoring.router, prefix="/api/scoring", tags=["채점"])
app.include_router(containers.router, prefix="/api/containers", tags=["컨테이너"])
app.include_router(scoreboard.router, prefix="/api/scoreboard", tags=["스코어보드"])
app.include_router(discord_bot.router, prefix="/api/discord", tags=["Discord"])


@app.get("/health")
async def root_health():
    return {"status": "ok", "service": "mock-externals", "version": "1.0.0"}
