"""플래그 슬롯 정규화 유틸리티."""

from __future__ import annotations

import re
from typing import Any


DEFAULT_FLAG_FORMAT = "FLAG{opaque-hmac}"
DIFFICULTY_ORDER = {"Easy": 0, "Medium": 1, "Hard": 2}


def slugify_slot_key(value: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", (value or "").strip().lower()).strip("-")
    return slug or "flag"


def sanitize_flag_filename(value: str | None, fallback_key: str) -> str:
    raw = (value or "").strip()
    if not raw:
        raw = f"flag-{fallback_key}.txt"
    name = raw.rsplit("/", 1)[-1].replace("\\", "")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    if not name:
        name = f"flag-{fallback_key}.txt"
    if not name.lower().endswith(".txt"):
        name = f"{name}.txt"
    return name


def normalize_slot_difficulty(value: str | None, fallback: str = "Easy") -> str:
    raw = (value or "").strip()
    if raw in DIFFICULTY_ORDER:
        return raw
    return fallback if fallback in DIFFICULTY_ORDER else "Easy"


def build_default_flag_slots(score: int = 100, difficulty: str = "Easy") -> list[dict[str, Any]]:
    return [
        {
            "slot_key": "flag-1",
            "label": "플래그 1",
            "filename": "flag.txt",
            "points": max(int(score or 100), 1),
            "difficulty": normalize_slot_difficulty(difficulty),
        }
    ]


def normalize_flag_slots(
    raw_slots: list[dict[str, Any]] | None,
    *,
    fallback_score: int = 100,
    fallback_difficulty: str = "Easy",
) -> list[dict[str, Any]]:
    slots = raw_slots or build_default_flag_slots(fallback_score, fallback_difficulty)
    if not isinstance(slots, list) or not slots:
        raise ValueError("플래그 슬롯은 최소 1개 이상이어야 합니다.")

    normalized: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    seen_files: set[str] = set()

    for index, raw in enumerate(slots, start=1):
        if hasattr(raw, "model_dump"):
            raw = raw.model_dump()
        elif hasattr(raw, "dict"):
            raw = raw.dict()

        if not isinstance(raw, dict):
            raise ValueError("플래그 슬롯 형식이 올바르지 않습니다.")

        label = str(raw.get("label") or "").strip() or f"플래그 {index}"
        base_key = str(raw.get("slot_key") or raw.get("filename") or label)
        slot_key = slugify_slot_key(base_key)
        if slot_key in seen_keys:
            raise ValueError(f"중복된 플래그 슬롯 키가 있습니다: {slot_key}")

        filename = sanitize_flag_filename(raw.get("filename"), slot_key)
        if filename in seen_files:
            raise ValueError(f"중복된 플래그 파일명이 있습니다: {filename}")

        try:
            points = int(raw.get("points") or fallback_score or 100)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{label} 슬롯의 점수 형식이 올바르지 않습니다.") from exc
        if points <= 0:
            raise ValueError(f"{label} 슬롯의 점수는 1 이상이어야 합니다.")

        normalized.append(
            {
                "slot_key": slot_key,
                "label": label,
                "filename": filename,
                "points": points,
                "difficulty": normalize_slot_difficulty(raw.get("difficulty"), fallback_difficulty),
            }
        )
        seen_keys.add(slot_key)
        seen_files.add(filename)

    return normalized


def calculate_total_flag_points(flag_slots: list[dict[str, Any]]) -> int:
    return sum(int(slot.get("points") or 0) for slot in flag_slots)


def derive_service_difficulty(flag_slots: list[dict[str, Any]], fallback: str = "Easy") -> str:
    if not flag_slots:
        return normalize_slot_difficulty(fallback)
    return max(
        (normalize_slot_difficulty(slot.get("difficulty"), fallback) for slot in flag_slots),
        key=lambda value: DIFFICULTY_ORDER.get(value, 0),
    )
