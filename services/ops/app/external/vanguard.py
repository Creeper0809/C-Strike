"""뱅가드 네트워크 존 관리 클라이언트."""
from app.external.base import ExternalClient
from typing import Any


class VanguardClient(ExternalClient):
    """뱅가드 네트워크 존 관리 클라이언트."""

    async def get_zones(self) -> list[dict[str, Any]]:
        return await self.get("/api/vanguard/zones")

    async def get_zone_status(self, zone_id: str) -> dict[str, Any]:
        return await self.get(f"/api/vanguard/zones/{zone_id}/status")

    async def isolate_zone(self, zone_id: str, reason: str) -> dict[str, Any]:
        return await self.post(f"/api/vanguard/zones/{zone_id}/isolate", {"reason": reason})

    async def restore_zone(self, zone_id: str, reason: str) -> dict[str, Any]:
        return await self.post(f"/api/vanguard/zones/{zone_id}/restore", {"reason": reason})

    async def health(self) -> dict[str, Any]:
        return await self.get("/api/vanguard/health")
