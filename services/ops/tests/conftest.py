"""테스트 공통 설정 — Mock 외부 시스템 + 테스트 DB 없이 API 테스트."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.mock.mock_server import app as mock_app
from app.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def mock_client():
    """Mock 서버 테스트 클라이언트."""
    transport = ASGITransport(app=mock_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


# 참고: 메인 앱의 CRUD 테스트는 DB가 필요하므로
# Docker 환경에서만 실행 가능합니다.
# 여기서는 Mock 서버 테스트만 제공합니다.
