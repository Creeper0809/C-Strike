"""Mock 컨테이너 관리 라우터."""
import uuid

from fastapi import APIRouter, HTTPException, Query

from app.mock.scenarios import get_data
from app.mock.state import now_iso

router = APIRouter()


@router.get("/teams")
async def list_teams(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["containers"]["teams"]


@router.get("/teams/{team_id}")
async def get_team(team_id: str, scenario: str = Query("normal")):
    data = get_data(scenario)
    teams = data["containers"]["teams"]

    if isinstance(teams, list):
        for team in teams:
            if str(team.get("team_id")) == team_id or str(team.get("id")) == team_id:
                return team

    raise HTTPException(status_code=404, detail=f"Team {team_id} not found")


@router.post("/teams/{team_id}/reset")
async def reset_team(team_id: str):
    return {
        "success": True,
        "reset_at": now_iso(),
        "containers_restarted": 3,
    }


@router.post("/teams/{team_id}/stop")
async def stop_team(team_id: str):
    return {"success": True, "stopped_at": now_iso()}


@router.post("/deploy")
async def deploy():
    deploy_id = f"deploy-{uuid.uuid4().hex[:8]}"
    return {"deploy_id": deploy_id, "status": "deploying"}


@router.delete("/deploy/{deploy_id}")
async def rollback_deploy(deploy_id: str):
    return {"success": True, "rolled_back_at": now_iso()}


@router.get("/teams/{team_id}/logs")
async def team_logs(team_id: str):
    return {"logs": f"[mock] team={team_id} | container logs output..."}


@router.get("/health")
async def health(scenario: str = Query("normal")):
    data = get_data(scenario)
    return data["containers"]["health"]
