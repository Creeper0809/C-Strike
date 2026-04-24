"""Dockerfile HEALTHCHECK 지시어 파싱 단위 테스트."""
from app.api.services import parse_dockerfile_healthcheck


def test_curl_with_flag():
    content = "HEALTHCHECK CMD curl -f http://localhost:8080/healthz || exit 1"
    assert parse_dockerfile_healthcheck(content) == "/healthz"


def test_wget_quiet():
    content = "HEALTHCHECK CMD wget -qO- http://localhost/ping"
    assert parse_dockerfile_healthcheck(content) == "/ping"


def test_with_interval_option():
    content = "HEALTHCHECK --interval=30s --retries=3 CMD curl http://127.0.0.1:3000/health"
    assert parse_dockerfile_healthcheck(content) == "/health"


def test_no_healthcheck():
    content = "FROM python:3.11\nRUN pip install flask\nCMD python app.py"
    assert parse_dockerfile_healthcheck(content) is None


def test_healthcheck_none():
    content = "HEALTHCHECK NONE"
    assert parse_dockerfile_healthcheck(content) is None


def test_case_insensitive():
    content = "healthcheck cmd curl HTTP://localhost/api/health"
    assert parse_dockerfile_healthcheck(content) == "/api/health"


def test_nested_path():
    content = "HEALTHCHECK CMD curl -sSf http://localhost:9000/api/v1/health/live"
    assert parse_dockerfile_healthcheck(content) == "/api/v1/health/live"


def test_multiline_dockerfile():
    content = """FROM alpine
RUN apk add curl
HEALTHCHECK CMD curl -f http://localhost/status
CMD ["/app"]
"""
    assert parse_dockerfile_healthcheck(content) == "/status"
