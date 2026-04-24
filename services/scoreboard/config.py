"""스코어보드 v2 환경변수 설정.

운영 포털 공개 API 베이스, 대회 ID, 폴링 주기를 환경변수로 받는다.
``COMPETITION_ID``가 비어있으면 server.py가 부팅 시 운영 포털의
``/active-competitions`` 엔드포인트를 호출해 자동 감지한다.
"""

import os


class Settings:
    """스코어보드 v2 런타임 설정 — 환경변수 기반."""

    # 운영 포털 공개 API 베이스 (끝에 슬래시 없음).
    # 기본값은 cstrike-ops-network 내부에서 ops-backend 컨테이너를 직접 호출한다.
    # 자가서명 SSL 경고/nginx 경유를 피할 수 있어 같은 네트워크 내 스코어보드
    # 컨테이너에 이상적이다.
    OPS_API_BASE: str = os.environ.get(
        "OPS_API_BASE",
        "http://ops-backend:8400/api/v1/scoreboard",
    )

    # 표시할 대회 UUID (비어있으면 부팅 시 /active-competitions로 자동 감지)
    COMPETITION_ID: str = os.environ.get("COMPETITION_ID", "")

    # 운영 포털 폴링 주기 (초) — 기본 5초
    POLL_INTERVAL_SEC: float = float(
        os.environ.get("SCOREBOARD_POLL_INTERVAL", "5.0")
    )

    # HTTP 타임아웃 (초) — 기본 10초
    HTTP_TIMEOUT_SEC: float = float(
        os.environ.get("SCOREBOARD_HTTP_TIMEOUT", "10.0")
    )

    # 차트 상위 N개 팀 (운영 포털 chart 엔드포인트에 전달)
    CHART_TOP_N: int = int(os.environ.get("SCOREBOARD_CHART_TOP", "10"))

    # 이벤트 피드 최대 건수
    EVENT_LIMIT: int = int(os.environ.get("SCOREBOARD_EVENT_LIMIT", "100"))

    # 자가서명 인증서 환경에서 SSL 검증 여부 (운영 포털 기본: 자가서명)
    HTTP_VERIFY_SSL: bool = os.environ.get(
        "SCOREBOARD_VERIFY_SSL", "false"
    ).lower() in ("1", "true", "yes", "on")


settings = Settings()
