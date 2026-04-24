"""운영 포털 공개 API 비동기 클라이언트.

5개 엔드포인트(``info``/``rankings``/``chart``/``matrix``/``events``)를 병렬 호출하여
스코어보드 상태 구성용 원시 데이터를 묶어서 반환한다.

개별 엔드포인트 실패는 해당 키만 빈 dict로 대체되고 전체 fetch는 실패하지 않는다.
운영 포털은 자가서명 SSL 환경이 기본이므로 ``HTTP_VERIFY_SSL`` 설정을 따른다.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from config import settings

logger = logging.getLogger("scoreboard.ops_client")


class OpsClient:
    """운영 포털 공개 API 클라이언트.

    Parameters
    ----------
    base_url:
        오버라이드용 베이스 URL. 비워두면 ``settings.OPS_API_BASE`` 사용.
    competition_id:
        오버라이드용 대회 UUID. 비워두면 ``settings.COMPETITION_ID`` 사용.
    """

    _KEYS: tuple[str, ...] = ("info", "rankings", "chart", "matrix", "events")

    def __init__(
        self,
        base_url: str | None = None,
        competition_id: str | None = None,
    ) -> None:
        self._base = (base_url or settings.OPS_API_BASE).rstrip("/")
        self._competition_id = competition_id or settings.COMPETITION_ID
        self._timeout = settings.HTTP_TIMEOUT_SEC
        self._verify = settings.HTTP_VERIFY_SSL

    @property
    def competition_id(self) -> str:
        return self._competition_id

    def set_competition_id(self, competition_id: str) -> None:
        """런타임에 표시 대상 대회를 변경한다 (자동 감지 후 재설정용)."""
        self._competition_id = competition_id

    def _url(self, path: str) -> str:
        return f"{self._base}/{self._competition_id}{path}"

    async def fetch_active_competitions(self) -> list[dict[str, Any]]:
        """종료되지 않은 대회 목록을 조회한다 (인증 불필요).

        ``COMPETITION_ID`` 환경변수가 비어있을 때 server.py 부팅 시
        첫 번째 활성 대회를 자동 선택하기 위해 사용한다.
        실패 시 빈 리스트를 반환하며 예외를 던지지 않는다.
        """
        url = f"{self._base}/active-competitions"
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, verify=self._verify
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                payload = resp.json()
            return list(payload.get("competitions") or [])
        except Exception as exc:
            logger.error("active-competitions 조회 실패: %s", exc)
            return []

    async def _get(
        self,
        client: httpx.AsyncClient,
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """단일 엔드포인트 GET. 2xx 이외면 예외."""
        resp = await client.get(self._url(path), params=params)
        resp.raise_for_status()
        return resp.json()

    async def fetch_all(self) -> dict[str, Any]:
        """5개 엔드포인트를 병렬 호출하여 원시 응답을 묶어 반환한다.

        개별 요청 실패 시 해당 키만 빈 dict로 대체되고 로그만 남긴다.
        COMPETITION_ID 미설정이면 네트워크 호출 없이 즉시 빈 구조를 반환한다.
        """
        if not self._competition_id:
            logger.warning("COMPETITION_ID 미설정 — 빈 상태 반환")
            return {key: {} for key in self._KEYS}

        async with httpx.AsyncClient(
            timeout=self._timeout, verify=self._verify
        ) as client:
            results = await asyncio.gather(
                self._get(client, "/info"),
                self._get(client, "/rankings"),
                self._get(client, "/chart", params={"top": settings.CHART_TOP_N}),
                self._get(client, "/matrix"),
                self._get(client, "/events", params={"limit": settings.EVENT_LIMIT}),
                return_exceptions=True,
            )

        bundled: dict[str, Any] = {}
        for key, result in zip(self._KEYS, results):
            if isinstance(result, Exception):
                logger.error("운영 포털 %s 호출 실패: %s", key, result)
                bundled[key] = {}
            else:
                bundled[key] = result
        return bundled
