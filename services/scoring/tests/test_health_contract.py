import socket

import pytest
from aiohttp import web

from scoring.health_contract import run_health_contract


def _get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _start_test_server(routes: list[tuple[str, str, callable]]):
    app = web.Application()
    for method, path, handler in routes:
        app.router.add_route(method, path, handler)

    runner = web.AppRunner(app)
    await runner.setup()
    port = _get_free_port()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    return runner, f"http://127.0.0.1:{port}"


@pytest.mark.asyncio
async def test_health_contract_success():
    async def root(_request):
        return web.Response(text="Index of /")

    async def team_info(_request):
        return web.Response(text="team_name=alpha\nteam_code=AT-0001")

    runner, base_url = await _start_test_server(
        [
            ("GET", "/", root),
            ("GET", "/team-info.txt", team_info),
        ]
    )

    try:
        ok, response_time_ms, error = await run_health_contract(
            base_url,
            {
                "version": 1,
                "steps": [
                    {
                        "name": "root",
                        "request": {"method": "GET", "path": "/"},
                        "expect": {"status": 200, "body_contains": ["Index of /"]},
                    },
                    {
                        "name": "team info",
                        "request": {"method": "GET", "path": "/team-info.txt"},
                        "expect": {"status": 200, "body_contains": ["team_name=", "team_code="]},
                    },
                ],
            },
        )
    finally:
        await runner.cleanup()

    assert ok is True
    assert response_time_ms is not None
    assert error is None


@pytest.mark.asyncio
async def test_health_contract_failure():
    async def root(_request):
        return web.Response(text="hello")

    runner, base_url = await _start_test_server(
        [
            ("GET", "/", root),
        ]
    )

    try:
        ok, _response_time_ms, error = await run_health_contract(
            base_url,
            {
                "version": 1,
                "steps": [
                    {
                        "name": "root",
                        "request": {"method": "GET", "path": "/"},
                        "expect": {"status": 200, "body_contains": ["Index of /"]},
                    }
                ],
            },
        )
    finally:
        await runner.cleanup()

    assert ok is False
    assert "응답 본문" in (error or "")
