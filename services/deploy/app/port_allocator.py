"""Redis SET 기반 원자적 포트 할당기.

CTFd env-orchestrator(`internal/container/port_allocator.go`) 패턴을 Python으로 이식.

동작:
- 범위: 10000~65000 (참가자 노출용 호스트 포트 대역)
- 할당: Redis SADD로 원자적 예약 (1=성공, 0=이미 존재)
    - 1단계: 랜덤 10회 시도 (빠른 경로)
    - 2단계: 순차 스캔 (충돌 많을 때 fallback)
    - 3단계: 풀 소진 → RuntimeError
- 해제: 기본 30초 쿨다운 (TIME_WAIT 방지) 후 SREM
- 키: Redis SET `cstrike:allocated_ports`

Thread-safe: 각 호출마다 Redis 클라이언트를 새로 열고 닫는다(운영에는 아주 약간 느리지만
컨테이너 생성은 초당 수 건 수준이라 무관). release의 cooldown은 threading.Timer로 처리.
"""
import secrets
import threading

import redis

from app.config import settings

_ALLOCATED_KEY = "cstrike:allocated_ports"
_MAX_RANDOM_RETRIES = 10
_PORT_COOLDOWN_SEC = 30
PORT_MIN = 10000
PORT_MAX = 65000


def _rdb() -> redis.Redis:
    return redis.from_url(settings.REDIS_URL)


def allocate_port() -> int:
    """미사용 호스트 포트를 원자적으로 할당하여 반환한다.

    Raises:
        RuntimeError: 포트 풀 소진.
    """
    rdb = _rdb()
    try:
        port_range = PORT_MAX - PORT_MIN + 1

        for _ in range(_MAX_RANDOM_RETRIES):
            port = secrets.randbelow(port_range) + PORT_MIN
            if rdb.sadd(_ALLOCATED_KEY, port) == 1:
                return port

        for port in range(PORT_MIN, PORT_MAX + 1):
            if rdb.sadd(_ALLOCATED_KEY, port) == 1:
                return port

        raise RuntimeError(
            f"포트 풀 소진: {PORT_MIN}~{PORT_MAX} 범위 내 사용 가능한 포트 없음"
        )
    finally:
        rdb.close()


def release_port(port: int, cooldown: bool = True) -> None:
    """포트를 해제한다.

    cooldown=True (기본): 30초 후 SREM — 같은 포트가 즉시 재할당되어
    OS의 TIME_WAIT 상태와 충돌하는 것을 방지.
    cooldown=False: 즉시 해제 — rollback(할당 직후 실패) 시에만 사용.
    """
    def _do_release() -> None:
        rdb = _rdb()
        try:
            rdb.srem(_ALLOCATED_KEY, port)
        finally:
            rdb.close()

    if cooldown:
        timer = threading.Timer(_PORT_COOLDOWN_SEC, _do_release)
        timer.daemon = True
        timer.start()
    else:
        _do_release()


def allocated_count() -> int:
    """현재 할당된 포트 수 (관제용)."""
    rdb = _rdb()
    try:
        return int(rdb.scard(_ALLOCATED_KEY) or 0)
    finally:
        rdb.close()


def release_ports_from_container_attrs(attrs: dict) -> None:
    """Docker 컨테이너 attrs에서 호스트 포트를 추출해 쿨다운 해제.

    기존 컨테이너를 제거할 때 바로 호출. 포트 포맷은 Docker API 표준:
        NetworkSettings.Ports = {"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "12345"}]}
    """
    ports_dict = (attrs or {}).get("NetworkSettings", {}).get("Ports") or {}
    for _container_port, bindings in ports_dict.items():
        if not bindings:
            continue
        for binding in bindings:
            host_port_str = (binding or {}).get("HostPort")
            if not host_port_str:
                continue
            try:
                host_port = int(host_port_str)
            except (TypeError, ValueError):
                continue
            if PORT_MIN <= host_port <= PORT_MAX:
                release_port(host_port, cooldown=True)
