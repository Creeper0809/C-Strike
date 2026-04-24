"""Mock 시나리오 데이터 로더."""
import json
from pathlib import Path

FIXTURES_DIR = Path(__file__).parent / "fixtures"
_cache: dict[str, dict] = {}


def get_data(scenario: str = "normal") -> dict:
    """시나리오별 fixture JSON을 로드하여 반환."""
    if scenario not in _cache:
        filepath = FIXTURES_DIR / f"{scenario}.json"
        if not filepath.exists():
            filepath = FIXTURES_DIR / "normal.json"
        with open(filepath, encoding="utf-8") as f:
            _cache[scenario] = json.load(f)
    return _cache[scenario]


def clear_cache():
    """캐시 초기화 (테스트용)."""
    _cache.clear()
