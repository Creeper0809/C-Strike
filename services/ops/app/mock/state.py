"""Mock 서버 변경 가능 상태."""
from datetime import datetime, timezone

_state = {
    "scoring_paused": False,
    "scoring_paused_at": None,
    "scoreboard_frozen": False,
    "scoreboard_frozen_at": None,
    "isolated_zones": [],
}


def get_state() -> dict:
    return _state


def reset_state():
    _state.update({
        "scoring_paused": False,
        "scoring_paused_at": None,
        "scoreboard_frozen": False,
        "scoreboard_frozen_at": None,
        "isolated_zones": [],
    })


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
