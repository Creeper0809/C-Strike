"""빌드 콜백 페이로드 키 매핑 단위 테스트.

builder.py가 발행하는 ``{"status": "success"|"failed"}`` 페이로드를
ops/main.py의 ``_handle_build_done``이 올바르게 해석하는지 검증한다.

과거 결함:
    - main.py가 ``data["build_status"]``를 읽어 매 빌드마다 KeyError 사일런트 실패.
    - 결과: Dockerfile 모드 서비스가 영원히 ``draft``에 갇힘.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.mark.asyncio
async def test_handle_build_done_success_maps_status_key():
    """builder가 발행하는 'status' 키를 main이 읽어야 한다 (build_status 아님)."""
    from app.main import _handle_build_done

    payload = {
        "service_id": "00000000-0000-0000-0000-000000000001",
        "status": "success",
        "docker_image": "cstrike-vuln-abc:latest",
        "image_id": "sha256:xxx",
        "timestamp": 1700000000.0,
    }
    mock_db = AsyncMock()
    mock_session_cm = MagicMock()
    mock_session_cm.__aenter__ = AsyncMock(return_value=mock_db)
    mock_session_cm.__aexit__ = AsyncMock(return_value=None)
    with patch("app.main.async_session", return_value=mock_session_cm):
        await _handle_build_done(payload)
    mock_db.execute.assert_called_once()
    mock_db.commit.assert_called_once()


@pytest.mark.asyncio
async def test_handle_build_done_failed_sets_draft_status():
    """빌드 실패 시 draft로 되돌려야 한다."""
    from app.main import _handle_build_done

    payload = {
        "service_id": "00000000-0000-0000-0000-000000000002",
        "status": "failed",
        "error": "Dockerfile parse error at line 3",
        "timestamp": 1700000000.0,
    }
    mock_db = AsyncMock()
    mock_session_cm = MagicMock()
    mock_session_cm.__aenter__ = AsyncMock(return_value=mock_db)
    mock_session_cm.__aexit__ = AsyncMock(return_value=None)
    with patch("app.main.async_session", return_value=mock_session_cm):
        await _handle_build_done(payload)
    mock_db.execute.assert_called_once()
    mock_db.commit.assert_called_once()


@pytest.mark.asyncio
async def test_handle_build_done_unknown_status_is_noop():
    """알 수 없는 상태는 무시하되 예외를 던지지 않는다."""
    from app.main import _handle_build_done

    payload = {
        "service_id": "00000000-0000-0000-0000-000000000003",
        "status": "wat",
    }
    mock_db = AsyncMock()
    mock_session_cm = MagicMock()
    mock_session_cm.__aenter__ = AsyncMock(return_value=mock_db)
    mock_session_cm.__aexit__ = AsyncMock(return_value=None)
    with patch("app.main.async_session", return_value=mock_session_cm):
        await _handle_build_done(payload)
    mock_db.execute.assert_not_called()
