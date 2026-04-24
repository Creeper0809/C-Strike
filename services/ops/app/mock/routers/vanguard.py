"""Mock 뱅가드 (네트워크 격리) 라우터."""
import uuid

from fastapi import APIRouter, HTTPException, Query

from app.mock.scenarios import get_data
from app.mock.state import get_state, now_iso

router = APIRouter()


@router.get("/zones")
async def list_zones(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["vanguard"]["zones"]


@router.get("/zones/{zone_id}/status")
async def zone_status(zone_id: str, scenario: str = Query("normal")):
    data = get_data(scenario)
    zones = data["vanguard"].get("zone_details", data["vanguard"]["zones"])

    # zone_details가 dict(key=zone_id)인 경우 직접 조회
    if isinstance(zones, dict):
        if zone_id in zones:
            st = get_state()
            zone_copy = {**zones[zone_id]}
            if zone_id in st["isolated_zones"]:
                zone_copy["isolated"] = True
            return zone_copy
    elif isinstance(zones, list):
        for zone in zones:
            if zone.get("zone_id") == zone_id or zone.get("id") == zone_id:
                st = get_state()
                zone_copy = {**zone}
                if zone_id in st["isolated_zones"]:
                    zone_copy["isolated"] = True
                return zone_copy

    raise HTTPException(status_code=404, detail=f"Zone {zone_id} not found")


@router.post("/zones/{zone_id}/isolate")
async def isolate_zone(zone_id: str):
    state = get_state()
    if zone_id not in state["isolated_zones"]:
        state["isolated_zones"].append(zone_id)
    return {"success": True, "isolated_at": now_iso()}


@router.post("/zones/{zone_id}/restore")
async def restore_zone(zone_id: str):
    state = get_state()
    if zone_id in state["isolated_zones"]:
        state["isolated_zones"].remove(zone_id)
    return {"success": True, "restored_at": now_iso()}


@router.get("/health")
async def health(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["vanguard"]["health"]
