"""네트워크 관제 Pydantic 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


# ── 요청 스키마 ──────────────────────────────────────────

class NetworkIsolateRequest(BaseModel):
    """POST /teams/{tid}/isolate, /isolate-all 요청 바디."""
    reason: str = Field(..., min_length=1, description="격리 사유 (필수)")


class NetworkRestoreRequest(BaseModel):
    """POST /teams/{tid}/restore, /restore-all 요청 바디."""
    reason: str = Field(..., min_length=1, description="복구 사유 (필수)")


# ── 팀별 네트워크 상태 ──────────────────────────────────────

class TeamServiceNetworkInfo(BaseModel):
    """팀 네트워크 상세 — 서비스 연결 정보."""
    service_name: str
    host_ip: str
    port: int
    reachable: bool
    response_time_ms: int | None = None

    model_config = {"from_attributes": True}


class TeamNetworkSummary(BaseModel):
    """전체 네트워크 상태 조회 시 팀 요약 정보."""
    team_id: UUID
    team_name: str
    subnet: str | None = None
    gateway_ip: str | None = None
    status: str  # "connected" | "isolated"
    ping_ms: int | None = None
    last_checked_at: datetime | None = None
    isolated_at: datetime | None = None
    isolation_reason: str | None = None

    model_config = {"from_attributes": True}


class TeamNetworkDetail(BaseModel):
    """특정 팀의 네트워크 상세 응답."""
    team_id: UUID
    team_name: str
    subnet: str | None = None
    gateway_ip: str | None = None
    status: str
    ping_ms: int | None = None
    vpn_profile_issued: bool = False
    active_connections: int = 0
    services: list[TeamServiceNetworkInfo] = []
    last_checked_at: datetime | None = None

    model_config = {"from_attributes": True}


# ── 전체 네트워크 상태 ──────────────────────────────────────

class NetworkStatusResponse(BaseModel):
    """GET /status 응답 — 전체 네트워크 상태 요약."""
    competition_id: UUID
    participant_subnet: str
    ops_subnet: str
    total_teams: int
    teams_online: int
    teams_isolated: int
    is_all_isolated: bool
    teams: list[TeamNetworkSummary]


# ── 격리/복구 응답 ──────────────────────────────────────────

class TeamIsolateResponse(BaseModel):
    """팀 단위 격리 응답."""
    team_id: UUID
    team_name: str
    subnet: str | None = None
    status: str
    message: str
    reason: str
    isolated_at: datetime


class TeamRestoreResponse(BaseModel):
    """팀 단위 복구 응답."""
    team_id: UUID
    team_name: str
    subnet: str | None = None
    status: str
    message: str
    reason: str
    restored_at: datetime


class BulkIsolateResponse(BaseModel):
    """전체 격리 응답."""
    competition_id: UUID
    is_all_isolated: bool
    affected_teams: int
    message: str
    reason: str
    isolated_at: datetime


class BulkRestoreResponse(BaseModel):
    """전체 복구 응답."""
    competition_id: UUID
    is_all_isolated: bool
    restored_teams: int
    message: str
    reason: str
    restored_at: datetime


# ── 서브넷 등록 ──────────────────────────────────────────

class SubnetAssignRequest(BaseModel):
    """PUT /subnets/{team_id} 요청 — 개별 팀 서브넷 등록/수정."""
    subnet: str = Field(..., pattern=r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d{1,2}$", description="CIDR (예: 10.10.1.0/24)")
    gateway_ip: str = Field(..., pattern=r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", description="게이트웨이 IP (예: 10.10.1.1)")


class SubnetBulkItem(BaseModel):
    """일괄 등록 시 개별 항목."""
    team_id: UUID
    subnet: str = Field(..., pattern=r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d{1,2}$")
    gateway_ip: str = Field(..., pattern=r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")


class SubnetBulkAssignRequest(BaseModel):
    """POST /subnets/bulk 요청 — 서브넷 일괄 등록."""
    assignments: list[SubnetBulkItem] = Field(..., min_length=1)


class SubnetAutoAssignRequest(BaseModel):
    """POST /subnets/auto-assign 요청 — 자동 할당."""
    base_prefix: str = Field(default="10.10", description="서브넷 프리픽스 (예: 10.10)")
    start_index: int = Field(default=1, ge=1, le=254, description="시작 인덱스 (10.10.{index}.0/24)")


class TeamSubnetInfo(BaseModel):
    """서브넷 등록 현황 — 팀별 정보."""
    team_id: UUID
    team_name: str
    team_code: str
    subnet: str | None = None
    gateway_ip: str | None = None
    vpn_profile_issued: bool = False
    registration_status: str  # "registered" | "unassigned"
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class SubnetListResponse(BaseModel):
    """GET /subnets 응답 — 전체 서브넷 등록 현황."""
    competition_id: UUID
    total_teams: int
    assigned_count: int
    unassigned_count: int
    vpn_issued_count: int
    teams: list[TeamSubnetInfo]


class SubnetAssignResponse(BaseModel):
    """서브넷 등록/수정 응답."""
    team_id: UUID
    team_name: str
    subnet: str
    gateway_ip: str
    message: str


class SubnetAutoAssignResponse(BaseModel):
    """자동 할당 응답."""
    competition_id: UUID
    assigned_count: int
    skipped_count: int
    assignments: list[TeamSubnetInfo]
    message: str


# ── 배포 현황 ──────────────────────────────────────────

class TeamDeployStatus(BaseModel):
    """배포 현황 — 팀별 정보."""
    team_id: UUID
    team_name: str
    subnet: str | None = None
    vulnpack_name: str | None = None
    deploy_status: str  # "completed" | "deploying" | "failed" | "pending" | "no_subnet"
    progress_pct: int = 0
    last_deploy_at: datetime | None = None

    model_config = {"from_attributes": True}


class DeployStatusResponse(BaseModel):
    """GET /deploy-status 응답."""
    competition_id: UUID
    total_teams: int
    deployed_count: int
    deploying_count: int
    pending_count: int
    teams: list[TeamDeployStatus]
