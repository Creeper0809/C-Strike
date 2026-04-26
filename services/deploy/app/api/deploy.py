"""배포 관련 API 엔드포인트 (deploy-service)"""
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

from app.deployer import run_pipeline, ServiceInfo, TeamInfo

router = APIRouter(prefix="/deploy", tags=["deploy"])


class TeamInput(BaseModel):
    team_id: str
    team_code: str
    name: str
    subnet: str | None = None
    gateway_ip: str | None = None
    competition_id: str
    ssh_port: int = 22
    ssh_user: str | None = None
    ssh_password: str | None = None


class ServiceInput(BaseModel):
    service_id: str
    name: str
    docker_image: str
    container_port: int
    health_check_endpoint: str | None = None
    healthcheck_scenarios: dict | None = None
    env_vars: dict | None = None
    flag_slots: list[dict] | None = None


class DeployTeamsRequest(BaseModel):
    pipeline_id: str
    service: ServiceInput
    teams: list[TeamInput]


class DeployResponse(BaseModel):
    pipeline_id: str
    status: str
    message: str


@router.post("/teams", response_model=DeployResponse, status_code=202)
async def deploy_to_teams(req: DeployTeamsRequest, background_tasks: BackgroundTasks):
    """팀 목록에 서비스 배포 (202 Accepted, 백그라운드 실행)."""
    service = ServiceInfo(
        service_id=req.service.service_id,
        name=req.service.name,
        docker_image=req.service.docker_image,
        container_port=req.service.container_port,
        health_check_endpoint=req.service.health_check_endpoint,
        healthcheck_scenarios=req.service.healthcheck_scenarios,
        env_vars=req.service.env_vars,
        flag_slots=req.service.flag_slots,
    )
    teams = [
        TeamInfo(
            team_id=t.team_id,
            team_code=t.team_code,
            name=t.name,
            subnet=t.subnet,
            gateway_ip=t.gateway_ip,
            competition_id=t.competition_id,
            ssh_port=t.ssh_port,
            ssh_user=t.ssh_user,
            ssh_password=t.ssh_password,
        )
        for t in req.teams
    ]
    background_tasks.add_task(run_pipeline, req.pipeline_id, service, teams)
    return DeployResponse(
        pipeline_id=req.pipeline_id,
        status="running",
        message=f"{len(teams)}개 팀에 배포를 시작합니다.",
    )


@router.post("/rollback/{pipeline_id}")
async def rollback_deployment(pipeline_id: str, req: DeployTeamsRequest | None = None):
    """배포 롤백 — 팀 서버의 cstrike 컨테이너 전부 삭제."""
    if not req or not req.teams:
        return {
            "pipeline_id": pipeline_id,
            "removed_containers": [],
            "message": "팀 정보가 없어 원격 정리 불가",
        }
    from app.ssh_executor import SSHExecutor

    removed = []
    for t in req.teams:
        if not t.gateway_ip or not t.ssh_user or not t.ssh_password:
            removed.append(f"{t.team_code}: SSH 정보 미설정")
            continue
        try:
            with SSHExecutor(t.gateway_ip, t.ssh_port, t.ssh_user, t.ssh_password) as ssh:
                result = ssh.exec(
                    "docker ps -a --filter label=cstrike-service=true"
                    " --format '{{.Names}}' | xargs -r docker rm -f"
                )
                removed.append(f"{t.team_code}: {result.stdout.strip() or '컨테이너 없음'}")
        except Exception as e:
            removed.append(f"{t.team_code}: 에러 ({e})")
    return {"pipeline_id": pipeline_id, "removed_containers": removed}
