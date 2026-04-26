from app.schemas.service import FlagSlotConfig
from app.utils.flag_slots import normalize_flag_slots


def test_normalize_flag_slots_accepts_pydantic_models():
    slots = [
        FlagSlotConfig(
            slot_key="flag-1",
            label="플래그 1",
            filename="flag.txt",
            points=100,
            difficulty="Easy",
        )
    ]

    normalized = normalize_flag_slots(slots)

    assert normalized[0]["slot_key"] == "flag-1"
    assert normalized[0]["filename"] == "flag.txt"
    assert normalized[0]["points"] == 100
