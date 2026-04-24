"""외부 시스템 공통 HTTP 클라이언트."""
import httpx
from typing import Any


class ExternalClient:
    """외부 시스템 API 호출 기본 클래스.

    headers 인자를 통해 모든 요청에 공통 헤더(API Key, Bearer 토큰 등)를
    자동 주입할 수 있다.
    """

    def __init__(
        self,
        base_url: str,
        timeout: float = 10.0,
        headers: dict[str, str] | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = dict(headers) if headers else {}

    async def get(self, path: str, params: dict | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.get(
                f"{self.base_url}{path}",
                params=params,
                headers=self.headers or None,
            )
            resp.raise_for_status()
            return resp.json()

    async def post(self, path: str, json_data: dict | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}{path}",
                json=json_data,
                headers=self.headers or None,
            )
            resp.raise_for_status()
            return resp.json()

    async def delete(self, path: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.delete(
                f"{self.base_url}{path}",
                headers=self.headers or None,
            )
            resp.raise_for_status()
            return resp.json()

    async def health(self) -> dict[str, Any]:
        return await self.get("/health")
