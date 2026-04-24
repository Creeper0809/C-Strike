"""대회 설정 API 라우터 --- 설정 조회/변경 및 결과 내보내기."""

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.api.deps import get_current_operator, require_role
from app.models.operator import Operator
from app.models.config import CompetitionConfig
from app.schemas.settings import (
    ConfigItemResponse,
    ConfigUpdateRequest,
    DiscordBotConfigResponse,
    DiscordBotConfigUpdateRequest,
)
from app.utils.audit import record_audit
from app.utils.events import publish_event

router = APIRouter(tags=["대회 설정"])

# 디스코드 봇 설정에 사용되는 키 목록
DISCORD_CONFIG_KEYS = [
    "discord_bot_token",
    "discord_guild_id",
    "discord_announcement_channel_id",
    "discord_emergency_channel_id",
    "discord_ticket_channel_id",
    "discord_admin_role_id",
    "bot_api_base_url",
    "bot_api_key",
]

# 마스킹이 필요한 민감 필드
_SENSITIVE_KEYS = {"discord_bot_token", "bot_api_key"}


def _mask_value(value: str) -> str:
    """민감 값을 마스킹한다. 예: 'abcdefghij' → 'abcd...ghij'"""
    if not value or len(value) <= 8:
        return "••••••••" if value else ""
    return f"{value[:4]}...{value[-4:]}"


# -- 엔드포인트 -------------------------------------------------------------

@router.get("/")
async def list_configs(
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """모든 대회 설정을 조회한다."""
    result = await db.execute(select(CompetitionConfig))
    configs = result.scalars().all()

    return [
        ConfigItemResponse.model_validate(cfg)
        for cfg in configs
    ]


@router.patch("/")
async def update_configs(
    body: ConfigUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
):
    """설정을 일괄 변경한다. 키가 없으면 신규 생성(upsert)."""
    updated_keys: list[str] = []

    for key, value in body.updates.items():
        result = await db.execute(
            select(CompetitionConfig).where(CompetitionConfig.key == key)
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.value = value
            existing.updated_by = current_operator.id
        else:
            new_config = CompetitionConfig(
                key=key,
                value=value,
                updated_by=current_operator.id,
            )
            db.add(new_config)

        updated_keys.append(key)

    await db.flush()

    await record_audit(
        db, current_operator, "ops.config.update",
        "config", None,
        {"updated_keys": updated_keys},
        request.client.host if request.client else None,
    )
    await db.commit()

    # 변경 후 전체 설정 반환
    result = await db.execute(select(CompetitionConfig))
    configs = result.scalars().all()

    return [
        ConfigItemResponse.model_validate(cfg)
        for cfg in configs
    ]


## ── 디스코드 봇 설정 ─────────────────────────────────────────

@router.get("/discord", response_model=DiscordBotConfigResponse)
async def get_discord_config(
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """디스코드 봇 설정을 조회한다. 토큰/키는 마스킹하여 반환."""
    result = await db.execute(
        select(CompetitionConfig).where(
            CompetitionConfig.key.in_(DISCORD_CONFIG_KEYS)
        )
    )
    configs = {cfg.key: cfg.value for cfg in result.scalars().all()}

    response_data: dict[str, str] = {}
    for key in DISCORD_CONFIG_KEYS:
        raw = configs.get(key, "")
        # JSON 값이 dict이면 빈 문자열 처리, 문자열이면 그대로
        val = str(raw) if raw else ""
        if key in _SENSITIVE_KEYS and val:
            val = _mask_value(val)
        response_data[key] = val

    return DiscordBotConfigResponse(**response_data)


@router.patch("/discord", response_model=DiscordBotConfigResponse)
async def update_discord_config(
    body: DiscordBotConfigUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(require_role("admin")),
):
    """디스코드 봇 설정을 변경한다. None이 아닌 필드만 업데이트(upsert)."""
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="변경할 설정이 없습니다.",
        )

    updated_keys: list[str] = []
    for key, value in updates.items():
        result = await db.execute(
            select(CompetitionConfig).where(CompetitionConfig.key == key)
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.value = value
            existing.updated_by = current_operator.id
        else:
            new_config = CompetitionConfig(
                key=key,
                value=value,
                updated_by=current_operator.id,
            )
            db.add(new_config)
        updated_keys.append(key)

    await db.flush()

    await record_audit(
        db, current_operator, "ops.config.discord.update",
        "config", None,
        {"updated_keys": updated_keys},
        request.client.host if request.client else None,
    )
    await db.commit()

    # Redis pub/sub로 설정 변경 이벤트 발행 — 봇이 구독하여 실시간 반영
    await publish_event("config:discord:updated", {"updated_keys": updated_keys})

    # 변경 후 마스킹된 설정 반환
    result = await db.execute(
        select(CompetitionConfig).where(
            CompetitionConfig.key.in_(DISCORD_CONFIG_KEYS)
        )
    )
    configs = {cfg.key: cfg.value for cfg in result.scalars().all()}

    response_data: dict[str, str] = {}
    for key in DISCORD_CONFIG_KEYS:
        raw = configs.get(key, "")
        val = str(raw) if raw else ""
        if key in _SENSITIVE_KEYS and val:
            val = _mask_value(val)
        response_data[key] = val

    return DiscordBotConfigResponse(**response_data)


@router.get("/export/results")
async def export_results(
    format: str = Query("json", pattern="^(csv|json)$"),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """결과 데이터를 CSV 또는 JSON으로 내보낸다.

    외부 스코어보드 API에서 팀 점수를 조회하여 반환한다.
    현재는 DB의 설정 데이터를 기반으로 내보내기를 수행한다.
    """
    # 스코어보드 관련 설정 조회
    result = await db.execute(select(CompetitionConfig))
    configs = result.scalars().all()

    data = [
        {
            "key": cfg.key,
            "value": cfg.value,
            "updated_at": str(cfg.updated_at) if cfg.updated_at else None,
        }
        for cfg in configs
    ]

    if format == "json":
        return JSONResponse(content=data)

    # CSV 형식
    csv_headers = ["key", "value", "updated_at"]

    def generate_csv():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(csv_headers)
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        for row in data:
            writer.writerow([
                row["key"],
                str(row["value"]),
                row["updated_at"] or "",
            ])
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    return StreamingResponse(
        generate_csv(),
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="results_export.csv"',
        },
    )
