"""컨테이너 관리 클라이언트."""
from app.external.base import ExternalClient
from typing import Any


class ContainerClient(ExternalClient):
    """컨테이너 관리 클라이언트."""

    async def get_all_teams(self) -> list[dict[str, Any]]:
        return await self.get("/api/containers/teams")

    async def get_team(self, team_id: str) -> dict[str, Any]:
        return await self.get(f"/api/containers/teams/{team_id}")

    async def reset_team(self, team_id: str, reason: str) -> dict[str, Any]:
        return await self.post(f"/api/containers/teams/{team_id}/reset", {"reason": reason})

    async def stop_team(self, team_id: str, reason: str) -> dict[str, Any]:
        return await self.post(f"/api/containers/teams/{team_id}/stop", {"reason": reason})

    async def deploy(
        self,
        service_id: str,
        docker_image: str,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "service_id": service_id,
            "docker_image": docker_image,
        }
        if config is not None:
            payload["config"] = config
        return await self.post("/api/containers/deploy", payload)

    async def rollback_deploy(self, deploy_id: str) -> dict[str, Any]:
        return await self.post(f"/api/containers/deploys/{deploy_id}/rollback")

    async def get_logs(
        self,
        team_id: str,
        lines: int | None = None,
        service: str | None = None,
    ) -> dict[str, Any]:
        params = {}
        if lines is not None:
            params["lines"] = lines
        if service is not None:
            params["service"] = service
        return await self.get(f"/api/containers/teams/{team_id}/logs", params=params or None)

    async def health(self) -> dict[str, Any]:
        return await self.get("/api/containers/health")
