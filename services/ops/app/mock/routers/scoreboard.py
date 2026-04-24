"""Mock 스코어보드 라우터."""
from fastapi import APIRouter, Query

from app.mock.scenarios import get_data
from app.mock.state import get_state, now_iso

router = APIRouter()


@router.get("/teams")
async def list_teams(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["scoreboard"]["teams"]


@router.get("/chains")
async def list_chains(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["scoreboard"]["chains"]


@router.get("/bonus")
async def list_bonus(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["scoreboard"]["bonus"]


@router.post("/freeze")
async def freeze_scoreboard():
    state = get_state()
    ts = now_iso()
    state["scoreboard_frozen"] = True
    state["scoreboard_frozen_at"] = ts
    return {"success": True, "frozen_at": ts}


@router.post("/unfreeze")
async def unfreeze_scoreboard():
    state = get_state()
    state["scoreboard_frozen"] = False
    state["scoreboard_frozen_at"] = None
    return {"success": True, "unfrozen_at": now_iso()}


@router.get("/health")
async def health(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["scoreboard"]["health"]
