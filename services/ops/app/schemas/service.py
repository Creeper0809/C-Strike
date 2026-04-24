"""취약 서비스 스키마."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class ServiceCreate(BaseModel):
    name: str
    description: str | None = None
    category: str  # web/pwnable/crypto/network/misc
    competition_id: UUID | None = None
    docker_image: str | None = None
    docker_compose_config: dict | None = None
    env_type: str = "image"  # "dockerfile" | "image"
    container_port: int | None = None
    exposed_ports: dict | list | None = None
    flag_format: str = "FLAG{...}"
    health_check_endpoint: str | None = None
    score: int = 100
    difficulty: str = "Easy"  # Easy / Medium / Hard


class ServiceUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    competition_id: UUID | None = None
    docker_image: str | None = None
    docker_compose_config: dict | None = None
    exposed_ports: dict | list | None = None
    flag_format: str | None = None
    health_check_endpoint: str | None = None
    score: int | None = None
    difficulty: str | None = None


class ServiceResponse(BaseModel):
    id: UUID
    name: str
    description: str | None = None
    category: str
    competition_id: UUID | None = None
    competition_name: str | None = None
    docker_image: str | None = None
    docker_compose_config: dict | None = None
    exposed_ports: dict | list | None = None
    flag_format: str | None = None
    health_check_endpoint: str | None = None
    env_type: str = "image"
    container_port: int | None = None
    build_status: str | None = None
    build_log: str | None = None
    build_started_at: datetime | None = None
    build_completed_at: datetime | None = None
    status: str
    score: int = 100
    difficulty: str = "Easy"
    registered_by: UUID
    registered_by_name: str | None = None
    approved_by: UUID | None = None
    approved_by_name: str | None = None
    approved_at: datetime | None = None
    rejection_reason: str | None = None
    version: int
    created_at: datetime | None = None
    updated_at: datetime | None = None
    model_config = {"from_attributes": True}


class RejectRequest(BaseModel):
    reason: str
