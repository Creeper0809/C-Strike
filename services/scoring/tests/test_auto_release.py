"""AutoReleaseChecker 단위 테스트."""

from datetime import datetime, timezone, timedelta
from uuid import uuid4
from unittest.mock import AsyncMock, patch

import pytest


def test_is_due_returns_false_before_offset():
    """offset에 아직 도달 안 했으면 False."""
    from scoring.auto_release import AutoReleaseChecker
    checker = AutoReleaseChecker()

    now = datetime(2026, 4, 12, 10, 0, 0, tzinfo=timezone.utc)
    start = datetime(2026, 4, 12, 9, 59, 0, tzinfo=timezone.utc)
    assert checker._is_due(start, offset_minutes=5, now=now) is False


def test_is_due_returns_true_at_exact_offset():
    """정확히 offset 도달 시 True."""
    from scoring.auto_release import AutoReleaseChecker
    checker = AutoReleaseChecker()

    start = datetime(2026, 4, 12, 9, 0, 0, tzinfo=timezone.utc)
    now = datetime(2026, 4, 12, 9, 5, 0, tzinfo=timezone.utc)
    assert checker._is_due(start, offset_minutes=5, now=now) is True


def test_is_due_returns_true_after_offset():
    """offset을 이미 지났으면 True (밀린 팩 공개)."""
    from scoring.auto_release import AutoReleaseChecker
    checker = AutoReleaseChecker()

    start = datetime(2026, 4, 12, 9, 0, 0, tzinfo=timezone.utc)
    now = datetime(2026, 4, 12, 11, 30, 0, tzinfo=timezone.utc)
    assert checker._is_due(start, offset_minutes=60, now=now) is True


def test_is_due_handles_naive_start():
    """naive datetime은 UTC로 해석."""
    from scoring.auto_release import AutoReleaseChecker
    checker = AutoReleaseChecker()

    start = datetime(2026, 4, 12, 9, 0, 0)
    now = datetime(2026, 4, 12, 9, 10, 0, tzinfo=timezone.utc)
    assert checker._is_due(start, offset_minutes=5, now=now) is True


@pytest.mark.asyncio
async def test_check_skips_when_paused():
    """paused 대회는 공개 건너뛰기."""
    from scoring.auto_release import AutoReleaseChecker
    checker = AutoReleaseChecker()

    with patch.object(checker, "_fetch_due_packs", new=AsyncMock()) as mock_fetch:
        result = await checker.check(
            competition_id=uuid4(),
            actual_start_at=datetime.now(timezone.utc) - timedelta(hours=1),
            competition_status="paused",
        )
        assert result == 0
        mock_fetch.assert_not_called()


@pytest.mark.asyncio
async def test_check_skips_when_start_at_none():
    """actual_start_at이 None이면 건너뛰기 (방어적)."""
    from scoring.auto_release import AutoReleaseChecker
    checker = AutoReleaseChecker()

    result = await checker.check(
        competition_id=uuid4(),
        actual_start_at=None,
        competition_status="running",
    )
    assert result == 0
