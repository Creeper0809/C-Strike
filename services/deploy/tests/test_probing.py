"""후보 경로 probing 단위 테스트 (requests mock 기반)."""
from unittest.mock import patch, MagicMock
from urllib.parse import urlparse

import requests

from app.builder import probe_health_endpoints, HEALTH_PROBE_CANDIDATES


def _mock_get(status_map: dict[str, int]):
    """URL 경로 → 상태 코드 매핑을 돌려주는 requests.get 모의 함수."""
    def _side_effect(url, *args, **kwargs):
        parsed = urlparse(url)
        p = parsed.path or "/"
        if p in status_map:
            resp = MagicMock()
            resp.status_code = status_map[p]
            return resp
        raise requests.ConnectionError("refused")
    return _side_effect


def test_finds_healthz_first():
    with patch("app.builder.requests.get", side_effect=_mock_get({"/healthz": 200})):
        assert probe_health_endpoints("localhost", 8080) == "/healthz"


def test_skips_failing_paths_until_success():
    with patch("app.builder.requests.get", side_effect=_mock_get({"/ping": 200})):
        assert probe_health_endpoints("localhost", 8080) == "/ping"


def test_ignores_4xx_5xx():
    status = {"/healthz": 401, "/health": 500, "/ping": 200}
    with patch("app.builder.requests.get", side_effect=_mock_get(status)):
        assert probe_health_endpoints("localhost", 8080) == "/ping"


def test_returns_none_when_all_fail():
    with patch("app.builder.requests.get", side_effect=requests.ConnectionError()):
        assert probe_health_endpoints("localhost", 8080) is None


def test_candidates_coverage():
    assert "/healthz" in HEALTH_PROBE_CANDIDATES
    assert "/health" in HEALTH_PROBE_CANDIDATES
    assert "/ping" in HEALTH_PROBE_CANDIDATES
    assert "/" in HEALTH_PROBE_CANDIDATES
