"""스코어보드 클라이언트."""
from app.external.base import ExternalClient
from typing import Any


class ScoreboardClient(ExternalClient):
    """스코어보드 관리 클라이언트."""

    async def get_teams(self) -> list[dict[str, Any]]:
        return await self.get("/api/scoreboard/teams")

    async def get_chains(self) -> list[dict[str, Any]]:
        return await self.get("/api/scoreboard/chains")

    async def get_bonus(self) -> dict[str, Any]:
        return await self.get("/api/scoreboard/bonus")

    async def freeze(self, reason: str) -> dict[str, Any]:
        return await self.post("/api/scoreboard/freeze", {"reason": reason})

    async def unfreeze(self) -> dict[str, Any]:
        return await self.post("/api/scoreboard/unfreeze")

    async def health(self) -> dict[str, Any]:
        return await self.get("/api/scoreboard/health")
