"""Mock 채점 시스템 라우터."""
import uuid
from typing import Optional

from fastapi import APIRouter, Query

from app.mock.scenarios import get_data
from app.mock.state import get_state, now_iso

router = APIRouter()


@router.get("/status")
async def scoring_status(scenario: str = Query("normal")):
    data = get_data(scenario)
    status = {**data["scoring"]["status"]}
    state = get_state()
    if state["scoring_paused"]:
        status["is_running"] = False
        status["paused_at"] = state["scoring_paused_at"]
    return status


@router.get("/rounds")
async def list_rounds(
    scenario: str = Query("normal"),
    from_round: Optional[int] = Query(None),
    to_round: Optional[int] = Query(None),
    limit: int = Query(50),
):
    data = get_data(scenario)
    rounds = data["scoring"]["rounds"]

    if isinstance(rounds, list):
        filtered = rounds
        if from_round is not None:
            filtered = [r for r in filtered if r.get("round", 0) >= from_round]
        if to_round is not None:
            filtered = [r for r in filtered if r.get("round", 0) <= to_round]
        return filtered[:limit]

    return rounds


@router.get("/errors")
async def list_errors(
    scenario: str = Query("normal"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
):
    data = get_data(scenario)
    errors = data["scoring"]["errors"]

    if isinstance(errors, list):
        start = (page - 1) * limit
        end = start + limit
        return {"items": errors[start:end], "total": len(errors), "page": page}

    return errors


@router.get("/attacks")
async def list_attacks(
    scenario: str = Query("normal"),
    team_id: Optional[str] = Query(None),
    service_id: Optional[str] = Query(None),
):
    data = get_data(scenario)
    attacks = data["scoring"]["attacks"]

    if isinstance(attacks, list):
        filtered = attacks
        if team_id is not None:
            filtered = [a for a in filtered if str(a.get("team_id")) == team_id]
        if service_id is not None:
            filtered = [a for a in filtered if str(a.get("service_id")) == service_id]
        return filtered

    return attacks


@router.post("/pause")
async def pause_scoring():
    state = get_state()
    ts = now_iso()
    state["scoring_paused"] = True
    state["scoring_paused_at"] = ts
    return {"success": True, "paused_at": ts}


@router.post("/resume")
async def resume_scoring():
    state = get_state()
    state["scoring_paused"] = False
    state["scoring_paused_at"] = None
    return {"success": True, "resumed_at": now_iso()}


@router.post("/flags/rotate")
async def rotate_flags():
    return {"success": True, "rotated_count": 3}


@router.get("/health")
async def health(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["scoring"]["health"]
