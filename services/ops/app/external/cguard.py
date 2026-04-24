"""C-Guard Integration API 클라이언트 — LLM 부정행위 방지 시스템 연동."""

import httpx
from typing import Any

from app.external.base import ExternalClient


class CGuardClient(ExternalClient):
    """C-Guard 서버와 통신하는 HTTP 클라이언트.

    모든 요청에 Bearer 토큰 인증 헤더를 자동 추가한다.
    """

    def __init__(self, base_url: str, token: str, timeout: float = 10.0):
        super().__init__(base_url, timeout)
        self._token = token

    def _auth_headers(self) -> dict[str, str]:
        """인증 헤더를 반환한다."""
        return {"Authorization": f"Bearer {self._token}"}

    # ── 오버라이드: 인증 헤더 주입 ──────────────────────────────

    async def get(self, path: str, params: dict | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.get(
                f"{self.base_url}{path}",
                params=params,
                headers=self._auth_headers(),
            )
            resp.raise_for_status()
            return resp.json()

    async def post(self, path: str, json_data: dict | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}{path}",
                json=json_data,
                headers=self._auth_headers(),
            )
            resp.raise_for_status()
            return resp.json()

    # ── C-Guard Integration API 메서드 ─────────────────────────

    async def get_participant(self, user_id: str) -> dict[str, Any]:
        """특정 참가자의 C-Guard 정보를 조회한다."""
        return await self.get(f"/v1/integration/cguard/participants/{user_id}")

    async def get_session(self, session_id: str) -> dict[str, Any]:
        """특정 세션의 상세 정보를 조회한다."""
        return await self.get(f"/v1/integration/cguard/sessions/{session_id}")

    async def get_summary(self) -> dict[str, Any]:
        """C-Guard 전체 요약 통계를 조회한다."""
        return await self.get("/v1/integration/cguard/summary")

    async def get_reason_codes(self) -> dict[str, Any]:
        """사유 코드 목록을 조회한다."""
        return await self.get("/v1/integration/cguard/reason-codes")

    async def verify_proof(self, data: dict) -> dict[str, Any]:
        """증빙 자료를 검증한다."""
        return await self.post("/v1/integration/cguard/proof/verify", json_data=data)

    async def get_discord_actions(self, params: dict | None = None) -> dict[str, Any]:
        """디스코드 연동 액션 목록을 조회한다."""
        return await self.get("/v1/integration/discord/actions", params=params)

    async def health(self) -> dict[str, Any]:
        """C-Guard 서버 헬스체크."""
        return await self.get("/health")
