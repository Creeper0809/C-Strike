"""HTTP/TCP 헬스체크 유틸리티"""
import asyncio
import socket

import httpx


async def http_health_check(
    url: str,
    retries: int = 3,
    interval: float = 5.0,
    timeout: float = 10.0,
) -> bool:
    """HTTP GET 헬스체크. retries만큼 재시도한다."""
    for attempt in range(retries):
        try:
            async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
                resp = await client.get(url)
                if resp.status_code < 500:
                    return True
        except (httpx.RequestError, httpx.TimeoutException):
            pass

        if attempt < retries - 1:
            await asyncio.sleep(interval)

    return False


async def tcp_health_check(
    host: str,
    port: int,
    retries: int = 3,
    interval: float = 5.0,
    timeout: float = 5.0,
) -> bool:
    """TCP 연결 헬스체크. retries만큼 재시도한다."""
    for attempt in range(retries):
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=timeout,
            )
            writer.close()
            await writer.wait_closed()
            return True
        except (OSError, asyncio.TimeoutError):
            pass

        if attempt < retries - 1:
            await asyncio.sleep(interval)

    return False


async def wait_for_container_healthy(
    host: str,
    port: int,
    health_endpoint: str | None = None,
    timeout: float = 30.0,
    check_interval: float = 2.0,
) -> bool:
    """컨테이너가 정상 응답할 때까지 대기한다."""
    elapsed = 0.0
    while elapsed < timeout:
        if health_endpoint:
            ok = await http_health_check(
                f"http://{host}:{port}{health_endpoint}",
                retries=1,
                interval=0,
                timeout=5.0,
            )
        else:
            ok = await tcp_health_check(host, port, retries=1, interval=0, timeout=5.0)

        if ok:
            return True

        await asyncio.sleep(check_interval)
        elapsed += check_interval

    return False
