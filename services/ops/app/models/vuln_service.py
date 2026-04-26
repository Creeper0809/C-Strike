"""취약점 서비스(VulnService) 모델."""

from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSON, UUID

from app.database import Base


class VulnService(Base):
    """CTF 취약점 서비스 정의."""

    __tablename__ = "vuln_services"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    connection_info = Column(Text)
    category = Column(String(50), nullable=False)  # web/pwnable/crypto/network/misc
    docker_image = Column(String(500), nullable=True)
    docker_compose_config = Column(JSON)
    exposed_ports = Column(JSON)
    flag_format = Column(String(100), default="FLAG{...}")
    flag_slots = Column(JSON, nullable=False, default=list)
    health_check_endpoint = Column(String(200))
    healthcheck_scenarios = Column(JSON)
    status = Column(
        String(20), nullable=False, default="draft"
    )  # draft/pending/approved/rejected/active/disabled
    registered_by = Column(
        UUID(as_uuid=True), ForeignKey("operators.id"), nullable=False
    )
    approved_by = Column(UUID(as_uuid=True), ForeignKey("operators.id"))
    approved_at = Column(DateTime(timezone=True))
    rejection_reason = Column(Text)
    version = Column(Integer, default=1)
    competition_id = Column(UUID(as_uuid=True), ForeignKey("competitions.id", ondelete="SET NULL"))

    # Phase 11: 배포 시스템 실체화
    env_type = Column(String(20), nullable=False, server_default="image")  # "dockerfile" | "image"
    container_port = Column(Integer, nullable=True)
    build_status = Column(String(20), nullable=True)  # null/building/success/failed
    build_log = Column(Text, nullable=True)
    build_started_at = Column(DateTime(timezone=True), nullable=True)
    build_completed_at = Column(DateTime(timezone=True), nullable=True)

    # 문제 카탈로그(score / difficulty) — 취약점팩 release 시 cstrike.problem 브리지가 그대로 반영한다.
    score = Column(Integer, nullable=False, server_default="100")
    difficulty = Column(String(20), nullable=False, server_default="Easy")  # Easy / Medium / Hard

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
