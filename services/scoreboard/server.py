"""C-STRIKE 2026 스코어보드 서버 (v2 — 운영 포털 연동판).

동작 개요
---------
- 운영 포털 공개 API(``/api/v1/scoreboard/{comp}/...``)를
  ``SCOREBOARD_POLL_INTERVAL``초마다 폴링한다.
- ``state_adapter.build_state``로 v2 프론트 기대 스키마로 변환한다.
- 연결된 모든 WebSocket 클라이언트에 JSON으로 브로드캐스트한다.
- 프리즈/리셋 등 상태 변경은 운영 포털이 담당하고, 이 서버는 읽기 전용 뷰어.

환경변수 (``config.py`` 참고)
----------------------------
- ``OPS_API_BASE``              운영 포털 공개 API 베이스
- ``COMPETITION_ID``            표시할 대회 UUID (필수)
- ``SCOREBOARD_POLL_INTERVAL``  폴링 주기(초), 기본 5.0
- ``SCOREBOARD_HTTP_TIMEOUT``   HTTP 타임아웃(초), 기본 10.0
- ``SCOREBOARD_CHART_TOP``      차트 top N, 기본 10
- ``SCOREBOARD_VERIFY_SSL``     자가서명 SSL 검증 여부, 기본 false

실행
----
::

    uvicorn server:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import settings
from ops_client import OpsClient
from state_adapter import build_state

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("scoreboard")


# ──────────────────────────── 기본 빈 상태 ────────────────────────────

_EMPTY_STATE: dict[str, Any] = {
    "round": 0,
    "is_frozen": False,
    "rankings": [],
    "teams": [],
    "score_history": {},
    "vulnpack_schedule": [],
    "services": [],
    "all_services": [],
    "attack_matrix": {},
    "defense_record": {},
    "bonus": {"problems": []},
}


# ──────────────────────────── 전역 런타임 상태 ────────────────────────────

_current_state: dict[str, Any] = dict(_EMPTY_STATE)
_connected_clients: list[WebSocket] = []
_ops_client = OpsClient()


async def _poll_and_broadcast() -> None:
    """운영 포털을 주기 폴링하여 상태를 갱신하고 WebSocket에 브로드캐스트."""
    global _current_state
    while True:
        # COMPETITION_ID가 비어있으면 매 틱 자동 재감지 시도.
        # scoreboard가 ops-backend보다 먼저 부팅해 lifespan 단계에서
        # active-competitions 조회가 실패한 경우에도 자동 복구된다.
        if not _ops_client.competition_id:
            await _auto_detect_competition()

        try:
            bundled = await _ops_client.fetch_all()
            _current_state = build_state(bundled)
        except Exception as exc:  # 폴링 예외는 로그만 남기고 다음 틱으로 진행
            logger.error("운영 포털 폴링 예외: %s", exc)

        message = json.dumps(_current_state, ensure_ascii=False)
        dead: list[WebSocket] = []
        for ws in _connected_clients:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in _connected_clients:
                _connected_clients.remove(ws)

        await asyncio.sleep(settings.POLL_INTERVAL_SEC)


async def _auto_detect_competition() -> None:
    """COMPETITION_ID 환경변수가 비어있으면 운영 포털에서 활성 대회를 자동 선택한다.

    우선순위: running > ready > draft (운영 포털이 정렬해서 반환).
    실패 시에도 에러 없이 통과 — 대회 생성 전이면 빈 상태가 그대로 표시된다.
    """
    if _ops_client.competition_id:
        return
    entries = await _ops_client.fetch_active_competitions()
    if not entries:
        logger.warning("활성 대회가 없어 빈 상태로 시작합니다. 운영 포털에서 대회 생성 후 재시작하면 자동 감지됩니다.")
        return
    first = entries[0]
    picked_id = str(first.get("id") or "")
    if picked_id:
        _ops_client.set_competition_id(picked_id)
        logger.info(
            "COMPETITION_ID 자동 감지 — %s (%s, status=%s)",
            picked_id,
            first.get("name", ""),
            first.get("status", ""),
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 수명주기 — 대회 자동 감지 후 폴링 태스크를 시작/중지한다."""
    await _auto_detect_competition()
    task = asyncio.create_task(_poll_and_broadcast())
    logger.info(
        "스코어보드 폴링 시작 (interval=%.1fs, comp=%s, base=%s)",
        settings.POLL_INTERVAL_SEC,
        _ops_client.competition_id or "(미설정)",
        settings.OPS_API_BASE,
    )
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="C-STRIKE Scoreboard v2", lifespan=lifespan)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """WebSocket 구독 — 연결 직후 현재 상태 1회 전송 후 keep-alive 대기."""
    await ws.accept()
    _connected_clients.append(ws)
    try:
        await ws.send_text(json.dumps(_current_state, ensure_ascii=False))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if ws in _connected_clients:
            _connected_clients.remove(ws)


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    """REST fallback — 현재 상태 스냅샷."""
    return _current_state


@app.get("/api/health")
async def health() -> dict[str, Any]:
    """운영 포털 연동 상태 확인용 헬스체크.

    ``competition_id``는 자동 감지된 값이 있으면 그것을, 없으면 환경변수 값을
    노출한다(둘 다 없으면 null).
    """
    active_cid = _ops_client.competition_id or settings.COMPETITION_ID or None
    return {
        "status": "ok",
        "ops_api_base": settings.OPS_API_BASE,
        "competition_id": active_cid,
        "poll_interval_sec": settings.POLL_INTERVAL_SEC,
        "connected_clients": len(_connected_clients),
        "round": _current_state.get("round", 0),
    }


# ──────────────────────────── 정적 파일 ────────────────────────────


@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse("static/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
