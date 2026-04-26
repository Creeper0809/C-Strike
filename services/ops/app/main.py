"""C-STRIKE 운영 포털 API — FastAPI 애플리케이션 진입점."""

import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text, update

from app.config import settings
from app.database import async_session, engine, Base
from app.middleware.security import SecurityHeadersMiddleware
from app.models import Operator  # noqa: F401 — 모든 모델 테이블 등록
from app.models import *  # noqa: F401, F403
from app.models.config import CompetitionConfig
from app.utils.security import hash_password
from app.api import auth, health, dashboard, services, vulnpacks, deploy, emergency
from app.api import scoring, containers, tickets, audit, settings_api, ws, competitions
from app.api import teams, flags, feedbacks, network, scoreboard_public, competition_results
from app.api import bot_api
from app.api import cguard
from app.api import discord_bot_admin
from app.api import discord_directory
from app.api import internal
from app.api import operators as operators_api


# ── Redis deploy-service 이벤트 리스너 ────────────────────────


async def _deploy_event_listener():
    """Redis pub/sub으로 deploy-service 이벤트를 수신하여 DB 업데이트."""
    import redis.asyncio as aioredis

    rd = aioredis.from_url(settings.REDIS_URL)
    pubsub = rd.pubsub()
    await pubsub.subscribe(
        "deploy:stage:progress",
        "deploy:pipeline:done",
        "deploy:build:done",
    )

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue
        try:
            channel = message["channel"]
            if isinstance(channel, bytes):
                channel = channel.decode()
            data = json.loads(message["data"])

            if channel == "deploy:stage:progress":
                await _handle_stage_progress(data)
            elif channel == "deploy:pipeline:done":
                await _handle_pipeline_done(data)
            elif channel == "deploy:build:done":
                await _handle_build_done(data)
        except Exception as e:
            print(f"[Redis 리스너] 이벤트 처리 에러: {e}")


async def _handle_stage_progress(data: dict):
    from app.models.deploy import DeployPipeline, DeployStage
    from datetime import datetime, timezone

    pipeline_id = data["pipeline_id"]
    stage_name = data["stage_name"]
    status = data["status"]

    async with async_session() as db:
        values = {
            "status": status,
            "log_output": data.get("log_output"),
            "error_detail": data.get("error_detail"),
        }
        if status == "running":
            values["started_at"] = datetime.now(timezone.utc)
        if status in ("success", "failed"):
            values["completed_at"] = datetime.now(timezone.utc)

        await db.execute(
            update(DeployStage)
            .where(DeployStage.pipeline_id == pipeline_id, DeployStage.stage_name == stage_name)
            .values(**values)
        )
        await db.execute(
            update(DeployPipeline)
            .where(DeployPipeline.id == pipeline_id)
            .values(current_stage=stage_name)
        )
        await db.commit()


async def _handle_pipeline_done(data: dict):
    from app.models.deploy import DeployPipeline
    from datetime import datetime, timezone

    async with async_session() as db:
        await db.execute(
            update(DeployPipeline)
            .where(DeployPipeline.id == data["pipeline_id"])
            .values(status=data["status"], error_detail=data.get("error_detail"),
                    completed_at=datetime.now(timezone.utc))
        )
        await db.commit()


async def _handle_build_done(data: dict):
    from app.models.vuln_service import VulnService

    # builder.py가 발행하는 키는 "status" ("success" | "failed").
    # ops 내부 컬럼명은 VulnService.build_status — 두 이름 혼동 금지.
    build_result = data.get("status")
    if build_result not in ("success", "failed"):
        return  # 알 수 없는 상태는 무시 (사일런트 KeyError 방지)

    async with async_session() as db:
        values = {
            "build_status": build_result,
            "build_completed_at": datetime.now(timezone.utc),
        }
        if data.get("docker_image"):
            values["docker_image"] = data["docker_image"]
        if data.get("error"):
            values["build_log"] = data["error"]

        # Task 3: 빌드 직후 probing으로 찾은 헬스체크 경로를 컬럼에 저장.
        # 관리자가 이미 수동 입력한 값은 builder 측에서 덮어쓰지 않음 (수동 우선).
        detected = data.get("detected_health_endpoint")
        if detected:
            values["health_check_endpoint"] = detected

        # 빌드 성공 → active 자동 전환, 실패 → draft로 되돌려 재시도 가능.
        if build_result == "success":
            values["status"] = "active"
        else:  # failed
            values["status"] = "draft"

        await db.execute(
            update(VulnService).where(VulnService.id == data["service_id"]).values(**values)
        )
        await db.commit()


async def _scheduled_deploy_runner():
    """예약된 배포 파이프라인을 주기적으로 실행한다."""
    from fastapi import HTTPException

    from app.api.deploy import (
        _dispatch_deployment,
        _get_approved_teams_or_raise,
        activate_scheduled_pipeline,
    )
    from app.models.deploy import DeployPipeline
    from app.models.vuln_service import VulnService

    while True:
        await asyncio.sleep(5)
        try:
            async with async_session() as db:
                now = datetime.now(timezone.utc)
                result = await db.execute(
                    select(DeployPipeline)
                    .where(
                        DeployPipeline.status == "scheduled",
                        DeployPipeline.scheduled_for.is_not(None),
                        DeployPipeline.scheduled_for <= now,
                    )
                    .order_by(DeployPipeline.scheduled_for.asc(), DeployPipeline.created_at.asc())
                )
                pipelines = list(result.scalars().all())

                for pipeline in pipelines:
                    service = await db.get(VulnService, pipeline.service_id)
                    if service is None:
                        pipeline.status = "failed"
                        pipeline.error_detail = "예약 배포 실행 실패: 원본 서비스가 존재하지 않습니다."
                        pipeline.completed_at = datetime.now(timezone.utc)
                        await db.commit()
                        continue
                    if service.status != "active":
                        pipeline.status = "failed"
                        pipeline.error_detail = f"예약 배포 실행 실패: 서비스 상태가 active가 아닙니다. (현재: {service.status})"
                        pipeline.completed_at = datetime.now(timezone.utc)
                        await db.commit()
                        continue

                    try:
                        teams = await _get_approved_teams_or_raise(db, service)
                    except HTTPException as exc:
                        pipeline.status = "failed"
                        pipeline.error_detail = f"예약 배포 실행 실패: {exc.detail}"
                        pipeline.completed_at = datetime.now(timezone.utc)
                        await db.commit()
                        continue

                    await activate_scheduled_pipeline(db, pipeline)
                    await db.commit()
                    await _dispatch_deployment(db, pipeline, service, teams)
        except Exception as e:
            print(f"[Scheduled Deploy Runner] error: {e}")


# ── 라이프사이클 ─────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 시작/종료 시 실행되는 라이프사이클 훅."""
    # startup: DB 테이블 자동 생성 (Alembic 마이그레이션 전 폴백)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception:
        pass  # 이미 존재하는 테이블/타입 충돌 무시 (워커 동시 실행 대응)
    # startup: operators 테이블을 최신 스키마로 idempotent 업그레이드 (discord_user_id 등)
    await _ensure_operator_schema()
    # startup: vuln_services 테이블에 score/difficulty 컬럼 보강 (문제 카탈로그 입력용)
    await _ensure_vuln_service_schema()
    # startup: 다중 플래그 슬롯/HMAC 메타데이터 컬럼 보강
    await _ensure_flag_schema()
    # startup: 팀 변경 작업 직렬화 인덱스 보강
    await _ensure_team_mutation_schema()
    # startup: 팀원 VPN 계정 메타데이터 보강
    await _ensure_team_member_vpn_schema()
    # startup: 예약 배포용 scheduled_for 컬럼 보강
    await _ensure_deploy_pipeline_schema()
    # startup: 초기 admin 계정 생성
    await _ensure_admin_account()
    # startup: Discord 봇 설정 8키를 .env → competition_config 로 초기 seed
    await _ensure_competition_config_seed()

    # Phase 11: Redis 이벤트 리스너 시작
    listener_task = asyncio.create_task(_deploy_event_listener())
    scheduled_deploy_task = asyncio.create_task(_scheduled_deploy_runner())

    yield

    # shutdown: Redis 리스너 종료
    listener_task.cancel()
    try:
        await listener_task
    except asyncio.CancelledError:
        pass
    scheduled_deploy_task.cancel()
    try:
        await scheduled_deploy_task
    except asyncio.CancelledError:
        pass

    # shutdown: 엔진 정리
    await engine.dispose()


app = FastAPI(
    title="C-STRIKE 운영 포털 API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS 미들웨어
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.ALLOWED_ORIGINS.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 보안 헤더 미들웨어
app.add_middleware(SecurityHeadersMiddleware)

# 라우터 등록
app.include_router(auth.router, prefix="/api/auth")
app.include_router(health.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api/dashboard")
app.include_router(services.router, prefix="/api/services")
app.include_router(vulnpacks.router, prefix="/api/vulnpacks")
app.include_router(deploy.router, prefix="/api/deploy")
app.include_router(emergency.router, prefix="/api/emergency")
app.include_router(scoring.router, prefix="/api/scoring")
app.include_router(containers.router, prefix="/api/containers")
app.include_router(tickets.router, prefix="/api/tickets")
app.include_router(audit.router, prefix="/api/audit")
app.include_router(settings_api.router, prefix="/api/settings")
app.include_router(ws.router, prefix="/api/ws")
app.include_router(competitions.router, prefix="/api/v1/competitions")
app.include_router(competition_results.router, prefix="/api/v1/competitions/{competition_id}")
app.include_router(teams.router, prefix="/api/v1/competitions/{competition_id}/teams")
app.include_router(flags.router, prefix="/api/v1/competitions/{competition_id}/flags")
app.include_router(feedbacks.router, prefix="/api/v1/competitions/{competition_id}/feedbacks")
app.include_router(network.router, prefix="/api/v1/competitions/{competition_id}/network")
app.include_router(scoreboard_public.router, prefix="/api/v1/scoreboard")
app.include_router(bot_api.router, prefix="/api/v1/bot")
app.include_router(cguard.router, prefix="/api/cguard")
app.include_router(discord_bot_admin.router, prefix="/api/discord-bot", tags=["discord-bot"])
app.include_router(discord_directory.router, prefix="/api/discord-directory", tags=["discord-directory"])
app.include_router(operators_api.router, prefix="/api/operators", tags=["operators"])
app.include_router(internal.router)


async def _ensure_admin_account():
    """환경변수의 ADMIN_USERNAME/PASSWORD로 초기 관리자 계정을 생성한다.

    이미 존재하면 건너뛴다.
    """
    async with async_session() as session:
        result = await session.execute(
            select(Operator).where(Operator.username == settings.ADMIN_USERNAME)
        )
        existing = result.scalar_one_or_none()

        if existing is None:
            admin = Operator(
                username=settings.ADMIN_USERNAME,
                password_hash=hash_password(settings.ADMIN_PASSWORD),
                display_name="관리자",
                role="admin",
                is_active=True,
            )
            session.add(admin)
            await session.commit()


# Discord 봇 설정 키 ↔ .env 환경변수 매핑
# .env 변수명은 외주 봇 관례 유지 (DISCORD_AUDIT_LOG_CHANNEL_ID/DISCORD_TICKET_CATEGORY_ID),
# DB 키는 운영포털 UI/스키마 관례 유지 (discord_announcement_channel_id 등).
_DISCORD_CONFIG_ENV_MAP = {
    "discord_bot_token": "DISCORD_TOKEN",
    "discord_guild_id": "DISCORD_GUILD_ID",
    "discord_announcement_channel_id": "DISCORD_AUDIT_LOG_CHANNEL_ID",
    "discord_emergency_channel_id": "DISCORD_EMERGENCY_CHANNEL_ID",
    "discord_ticket_channel_id": "DISCORD_TICKET_CATEGORY_ID",
    "discord_admin_role_id": "DISCORD_ADMIN_ROLE_ID",
    "bot_api_base_url": "BOT_API_BASE_URL",
    "bot_api_key": "BOT_API_KEY",
}


async def _ensure_competition_config_seed():
    """Discord 봇 설정 8키를 `.env` 환경변수에서 `competition_config`로 초기 seed.

    이미 DB에 해당 키가 존재하면 건드리지 않는다 (운영자가 UI에서 수정한 값 보존).
    덕분에 clean install 후 첫 기동만으로 UI `/settings` Discord 섹션이 실값을 표시한다.
    """
    async with async_session() as session:
        for db_key, env_key in _DISCORD_CONFIG_ENV_MAP.items():
            result = await session.execute(
                select(CompetitionConfig).where(CompetitionConfig.key == db_key)
            )
            if result.scalar_one_or_none() is not None:
                continue
            session.add(CompetitionConfig(key=db_key, value=os.getenv(env_key, "")))
        await session.commit()


async def _ensure_operator_schema():
    """기존 DB의 operators 테이블을 새 스키마로 idempotent 업그레이드.

    Base.metadata.create_all()은 기존 테이블에 컬럼을 추가하지 않는다.
    clean install 시에는 init SQL + create_all이 처리하지만, 기존 DB가
    존재하는 업그레이드 상황에서는 ALTER TABLE ... ADD COLUMN IF NOT EXISTS로
    누락된 컬럼(discord_user_id)을 안전하게 보강한다.
    """
    async with async_session() as db:
        await db.execute(text(
            "ALTER TABLE cstrike.operators "
            "ADD COLUMN IF NOT EXISTS discord_user_id VARCHAR(32)"
        ))
        await db.commit()


async def _ensure_vuln_service_schema():
    """기존 DB의 vuln_services 테이블에 score/difficulty 컬럼을 보강한다.

    운영자가 서비스(=문제)를 등록할 때 점수와 난이도를 입력할 수 있도록
    모델에 두 컬럼을 추가했다. clean install이 아닌 기존 환경에서는 ALTER로
    누락분만 추가한다. 둘 다 NOT NULL이지만 server_default를 지정해 기존 행은
    기본값(100 / Easy)으로 채워진다.
    """
    async with async_session() as db:
        await db.execute(text(
            "ALTER TABLE cstrike.vuln_services "
            "ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 100"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.vuln_services "
            "ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20) NOT NULL DEFAULT 'Easy'"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.vuln_services "
            "ADD COLUMN IF NOT EXISTS flag_slots JSON"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.vuln_services "
            "ADD COLUMN IF NOT EXISTS healthcheck_scenarios JSON"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.vuln_services "
            "ADD COLUMN IF NOT EXISTS connection_info TEXT"
        ))
        await db.execute(text(
            """
            UPDATE cstrike.vuln_services
            SET flag_slots = json_build_array(
                json_build_object(
                    'slot_key', 'flag-1',
                    'label', '플래그 1',
                    'filename', 'flag.txt',
                    'points', score,
                    'difficulty', COALESCE(difficulty, 'Easy')
                )
            )
            WHERE flag_slots IS NULL
            """
        ))
        await db.commit()


async def _ensure_flag_schema():
    """다중 플래그 슬롯/HMAC 메타데이터 컬럼과 제약을 보강한다."""
    async with async_session() as db:
        await db.execute(text(
            "ALTER TABLE cstrike.flags "
            "ADD COLUMN IF NOT EXISTS slot_key VARCHAR(64) NOT NULL DEFAULT 'primary'"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flags "
            "ADD COLUMN IF NOT EXISTS slot_label VARCHAR(100) NOT NULL DEFAULT '기본 플래그'"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flags "
            "ADD COLUMN IF NOT EXISTS flag_filename VARCHAR(255) NOT NULL DEFAULT 'flag.txt'"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flags "
            "ADD COLUMN IF NOT EXISTS point_value INTEGER NOT NULL DEFAULT 100"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flags "
            "ALTER COLUMN flag_value TYPE VARCHAR(255)"
        ))
        await db.execute(text(
            """
            UPDATE cstrike.flags f
            SET slot_key = COALESCE(NULLIF(f.slot_key, ''), 'primary'),
                slot_label = COALESCE(NULLIF(f.slot_label, ''), '기본 플래그'),
                flag_filename = COALESCE(NULLIF(f.flag_filename, ''), 'flag.txt'),
                point_value = COALESCE(f.point_value, vs.score, 100)
            FROM cstrike.vuln_services vs
            WHERE f.service_id = vs.id
            """
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flag_submissions "
            "ADD COLUMN IF NOT EXISTS slot_key VARCHAR(64)"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flag_submissions "
            "ADD COLUMN IF NOT EXISTS slot_label VARCHAR(100)"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flag_submissions "
            "ADD COLUMN IF NOT EXISTS points_awarded INTEGER"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.flag_submissions "
            "ALTER COLUMN submitted_flag TYPE VARCHAR(255)"
        ))
        await db.execute(text(
            """
            UPDATE cstrike.flag_submissions fs
            SET slot_key = COALESCE(fs.slot_key, f.slot_key),
                slot_label = COALESCE(fs.slot_label, f.slot_label),
                points_awarded = COALESCE(fs.points_awarded, f.point_value)
            FROM cstrike.flags f
            WHERE fs.flag_id = f.id
            """
        ))
        await db.execute(text(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'uq_flags_round_team_service'
                      AND connamespace = 'cstrike'::regnamespace
                ) THEN
                    ALTER TABLE cstrike.flags DROP CONSTRAINT uq_flags_round_team_service;
                END IF;
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'uq_flags_round_team_service_slot'
                      AND connamespace = 'cstrike'::regnamespace
                ) THEN
                    ALTER TABLE cstrike.flags
                    ADD CONSTRAINT uq_flags_round_team_service_slot
                    UNIQUE (round_id, team_id, service_id, slot_key);
                END IF;
            END $$;
            """
        ))
        await db.commit()


async def _ensure_team_mutation_schema():
    """팀 변경 작업 직렬화용 partial unique index를 보강한다."""
    async with async_session() as db:
        await db.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_team_mutations_running_resource_key "
            "ON cstrike.team_mutations (resource_key) "
            "WHERE status = 'running'"
        ))
        await db.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_team_mutations_team_id "
            "ON cstrike.team_mutations (team_id)"
        ))
        await db.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_team_mutations_started_at "
            "ON cstrike.team_mutations (started_at DESC)"
        ))
        await db.commit()


async def _ensure_team_member_vpn_schema():
    """기존 team_members 테이블에 팀원 VPN 메타데이터 컬럼을 보강한다."""
    async with async_session() as db:
        await db.execute(text(
            "ALTER TABLE cstrike.team_members "
            "ADD COLUMN IF NOT EXISTS vpn_username VARCHAR(128)"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.team_members "
            "ADD COLUMN IF NOT EXISTS vpn_ip VARCHAR(64)"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.team_members "
            "ADD COLUMN IF NOT EXISTS vpn_password TEXT"
        ))
        await db.execute(text(
            "ALTER TABLE cstrike.team_members "
            "ADD COLUMN IF NOT EXISTS vpn_password_updated_at TIMESTAMPTZ"
        ))
        await db.commit()


async def _ensure_deploy_pipeline_schema():
    """기존 deploy_pipelines 테이블에 예약 배포용 컬럼을 보강한다."""
    async with async_session() as db:
        await db.execute(text(
            "ALTER TABLE cstrike.deploy_pipelines "
            "ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ"
        ))
        await db.commit()
