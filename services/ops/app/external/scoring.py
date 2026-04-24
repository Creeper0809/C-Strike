"""채점 시스템 클라이언트."""
from app.external.base import ExternalClient
from typing import Any


class ScoringClient(ExternalClient):
    """채점 시스템 관리 클라이언트."""

    async def get_status(self) -> dict[str, Any]:
        return await self.get("/api/scoring/status")

    async def get_rounds(
        self,
        from_round: int | None = None,
        to_round: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        params = {}
        if from_round is not None:
            params["from_round"] = from_round
        if to_round is not None:
            params["to_round"] = to_round
        if limit is not None:
            params["limit"] = limit
        return await self.get("/api/scoring/rounds", params=params or None)

    async def get_errors(
        self,
        page: int | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        params = {}
        if page is not None:
            params["page"] = page
        if limit is not None:
            params["limit"] = limit
        return await self.get("/api/scoring/errors", params=params or None)

    async def get_attacks(
        self,
        team_id: str | None = None,
        service_id: str | None = None,
        from_dt: str | None = None,
        to_dt: str | None = None,
    ) -> list[dict[str, Any]]:
        params = {}
        if team_id is not None:
            params["team_id"] = team_id
        if service_id is not None:
            params["service_id"] = service_id
        if from_dt is not None:
            params["from_dt"] = from_dt
        if to_dt is not None:
            params["to_dt"] = to_dt
        return await self.get("/api/scoring/attacks", params=params or None)

    async def pause(self, reason: str) -> dict[str, Any]:
        return await self.post("/api/scoring/pause", {"reason": reason})

    async def resume(self, reason: str) -> dict[str, Any]:
        return await self.post("/api/scoring/resume", {"reason": reason})

    async def rotate_flags(self, service_id: str) -> dict[str, Any]:
        return await self.post(f"/api/scoring/services/{service_id}/rotate-flags")

    async def health(self) -> dict[str, Any]:
        return await self.get("/api/scoring/health")
