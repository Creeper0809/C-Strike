"""Discord 봇 클라이언트."""
from app.external.base import ExternalClient
from typing import Any


class DiscordBotClient(ExternalClient):
    """Discord 봇 관리 클라이언트."""

    async def announce(
        self,
        title: str,
        content: str,
        channel_type: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"title": title, "content": content}
        if channel_type is not None:
            payload["channel_type"] = channel_type
        return await self.post("/api/discord/announce", payload)

    async def notify_incident(
        self,
        incident_type: str,
        title: str,
        details: str,
        severity: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "incident_type": incident_type,
            "title": title,
            "details": details,
        }
        if severity is not None:
            payload["severity"] = severity
        return await self.post("/api/discord/incidents", payload)

    async def get_tickets(self) -> list[dict[str, Any]]:
        return await self.get("/api/discord/tickets")

    async def respond_ticket(
        self,
        ticket_id: str,
        content: str,
        author_name: str,
    ) -> dict[str, Any]:
        return await self.post(
            f"/api/discord/tickets/{ticket_id}/respond",
            {"content": content, "author_name": author_name},
        )

    async def close_ticket(
        self,
        ticket_id: str,
        resolution: str,
    ) -> dict[str, Any]:
        return await self.post(
            f"/api/discord/tickets/{ticket_id}/close",
            {"resolution": resolution},
        )

    async def health(self) -> dict[str, Any]:
        return await self.get("/health")

    async def create_team_role(self, team_name: str) -> dict[str, Any]:
        """운영포털에서 팀 생성 시 호출 — 봇이 Guild에 같은 이름 역할 생성.

        Returns: {"role_id": str, "role_name": str, "created": bool}
        """
        return await self.post(
            "/api/v1/run/requests/team/role",
            {"team_name": team_name},
        )

    async def delete_team_role(self, role_id: str) -> dict[str, Any]:
        """운영포털에서 팀 삭제 시 호출 — 봇이 Guild에서 역할 삭제.

        Returns: {"deleted": bool, "reason"?: str}
        """
        return await self.delete(
            f"/api/v1/run/requests/team/role/{role_id}",
        )

    async def assign_team_role(self, discord_user_id: str, role_id: str) -> dict[str, Any]:
        """운영포털에서 팀원 추가 시 호출 — 멤버에게 팀 역할 부여."""
        return await self.post(
            "/api/v1/run/requests/team/role/assign",
            {"discord_user_id": discord_user_id, "role_id": role_id},
        )

    async def grant_operator_role(self, discord_user_id: str) -> dict[str, Any]:
        """운영포털에서 운영자 생성/연동 시 호출 — 봇이 대상 멤버에게 '운영진' 역할 부여.

        create_team_role 패턴과 동일하게 봇 오프라인/오류 시 호출부에서 예외를 삼키고
        경고 로그만 남기도록 설계되어 있다. 여기서는 단순히 HTTP 호출만 수행.

        Args:
            discord_user_id: Discord snowflake (18~20자리 숫자 문자열).

        Returns: {"granted": bool, "role_id"?: str, "reason"?: str}
        """
        return await self.post(
            "/api/v1/run/requests/operator/role",
            {"discord_user_id": discord_user_id},
        )

    async def revoke_operator_role(self, discord_user_id: str) -> dict[str, Any]:
        """운영포털에서 운영자 비활성화/연동 해제 시 호출 — 봇이 '운영진' 역할 회수.

        Returns: {"revoked": bool, "reason"?: str}
        """
        return await self.delete(
            f"/api/v1/run/requests/operator/role/{discord_user_id}",
        )

    async def list_guild_members(self) -> dict[str, Any]:
        """Discord 길드 멤버 목록 조회."""
        return await self.get("/api/v1/run/requests/guild/members")
