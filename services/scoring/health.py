"""헬스체크 미니 HTTP 서버.

Docker 헬스체크용 경량 HTTP 서버. 표준 라이브러리만 사용하며
RoundRunner의 실행 상태를 JSON으로 응답한다.

엔드포인트:
    GET /health → 200 OK + JSON 상태 정보
    그 외 → 404 Not Found
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .round_runner import RoundRunner

logger = logging.getLogger("scoring.health")

HEALTH_PORT = 8460


class HealthServer:
    """asyncio 기반 헬스체크 HTTP 서버.

    RoundRunner 인스턴스의 상태를 참조하여 JSON 응답을 생성한다.
    """

    def __init__(self, runner: RoundRunner, port: int = HEALTH_PORT) -> None:
        self._runner = runner
        self._port = port
        self._start_time = time.monotonic()
        self._server: asyncio.Server | None = None

    async def start(self) -> None:
        """헬스체크 서버를 시작한다."""
        self._start_time = time.monotonic()
        self._server = await asyncio.start_server(
            self._handle_connection, "0.0.0.0", self._port
        )
        logger.info("헬스체크 서버 시작: port=%d", self._port)
        async with self._server:
            await self._server.serve_forever()

    async def stop(self) -> None:
        """헬스체크 서버를 중지한다."""
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            logger.info("헬스체크 서버 중지")

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """HTTP 요청을 처리한다."""
        try:
            request_line = await asyncio.wait_for(
                reader.readline(), timeout=5.0
            )
            request_text = request_line.decode("utf-8", errors="replace").strip()

            # 나머지 헤더 소비
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if line == b"\r\n" or line == b"\n" or line == b"":
                    break

            if request_text.startswith("GET /health"):
                body = self._build_health_response()
                status_line = "HTTP/1.1 200 OK"
            else:
                body = json.dumps({"error": "Not Found"})
                status_line = "HTTP/1.1 404 Not Found"

            response = (
                f"{status_line}\r\n"
                f"Content-Type: application/json\r\n"
                f"Content-Length: {len(body.encode())}\r\n"
                f"Connection: close\r\n"
                f"\r\n"
                f"{body}"
            )
            writer.write(response.encode())
            await writer.drain()
        except (asyncio.TimeoutError, ConnectionResetError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionResetError, BrokenPipeError):
                pass

    def _build_health_response(self) -> str:
        """헬스 상태 JSON을 생성한다."""
        uptime = int(time.monotonic() - self._start_time)

        data = {
            "status": "running" if self._runner._running else "stopped",
            "halted": self._runner._halted,
            "uptime_seconds": uptime,
        }
        return json.dumps(data, ensure_ascii=False)
