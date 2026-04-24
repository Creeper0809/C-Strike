"""대시보드 API 라우터 --- 종합 통계 및 시스템 상태 조회."""

import asyncio

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.api.deps import get_current_operator
from app.external.base import ExternalClient
from app.models.operator import Operator
from app.models.team import Team
from app.models.ticket import Ticket
from app.models.vuln_service import VulnService
from app.models.vulnpack import VulnpackSchedule
from app.schemas.dashboard import DashboardStatsResponse, SystemHealthItem

router = APIRouter(tags=["대시보드"])

# ── 외부 시스템 URL 매핑 ──────────────────────────────────────
# 모든 연동 대상 시스템을 등록 — 헬스체크 결과로 자동 판단
_EXTERNAL_SYSTEMS: dict[str, str] = {
    "scoring": settings.SCORING_URL,
    "scoreboard": settings.SCOREBOARD_URL,
    "deploy_service": settings.DEPLOY_SERVICE_URL,
    "cguard": settings.CGUARD_SERVER_URL,
    "discord_bot": settings.DISCORD_BOT_URL,
}


# ── 헬퍼 ─────────────────────────────────────────────────────

async def _fetch_health(url: str, name: str) -> SystemHealthItem:
    """외부 시스템 health 조회 — 연결 실패는 down, 응답 파싱 불가는 unknown."""
    # 서비스별 헬스체크 경로 매핑
    health_paths: dict[str, str] = {
        "scoring": "/health",
        "scoreboard": "/api/health",
        "deploy_service": "/health",
        "cguard": "/health",
        "discord_bot": "/health",
    }
    try:
        client = ExternalClient(url)
        path = health_paths.get(name, f"/api/{name}/health")
        data = await client.get(path)

        # status 정규화 — 외부 시스템이 "running"/"healthy" 등을 반환해도 "ok"로 통일
        raw_status = data.get("status", "unknown")
        if raw_status in ("running", "healthy", "ok"):
            normalized = "ok"
        elif raw_status in ("degraded", "warning"):
            normalized = "degraded"
        elif raw_status in ("down", "error", "stopped"):
            normalized = "down"
        else:
            normalized = "unknown"

        return SystemHealthItem(
            name=name,
            status=normalized,
            version=data.get("version"),
        )
    except httpx.ConnectError as e:
        # DNS 해석 실패 = Docker 네트워크에 컨테이너 자체가 없음 → 미연동
        cause = str(e.__cause__) if e.__cause__ else str(e)
        err_msg = (cause + str(e)).lower()
        if "name resolution" in err_msg or "name or service not known" in err_msg or "getaddrinfo" in err_msg:
            return SystemHealthItem(name=name, status="not_connected")
        # 그 외 연결 실패 (Connection refused 등) → 서비스 중단
        return SystemHealthItem(name=name, status="down")
    except (httpx.ConnectTimeout, httpx.TimeoutException):
        # 타임아웃 → 서비스 중단
        return SystemHealthItem(name=name, status="down")
    except httpx.HTTPStatusError:
        # HTTP 4xx/5xx 응답 → 서비스 중단
        return SystemHealthItem(name=name, status="down")
    except (ConnectionRefusedError, OSError):
        # OS 레벨 연결 거부 → 서비스 중단
        return SystemHealthItem(name=name, status="down")
    except Exception:
        # JSON 파싱 실패 등 예상 밖 오류 → 상태 불명
        return SystemHealthItem(name=name, status="unknown")


async def _fetch_scoring_stats_from_db(db: AsyncSession) -> dict:
    """DB에서 직접 채점 통계를 조회한다."""
    try:
        result = await db.execute(
            text("""
                SELECT
                    COALESCE(MAX(round_number), 0) AS current_round,
                    COUNT(*) AS total_rounds
                FROM cstrike.scoring_rounds
            """)
        )
        row = result.fetchone()
        current_round = row.current_round if row else 0
        total_rounds = row.total_rounds if row else 0

        # 최근 완료 라운드의 SLA 성공률
        latest = await db.execute(
            text("""
                SELECT id FROM cstrike.scoring_rounds
                WHERE status = 'completed'
                ORDER BY round_number DESC
                LIMIT 1
            """)
        )
        latest_row = latest.fetchone()
        success_rate = 0.0
        if latest_row:
            sla = await db.execute(
                text("""
                    SELECT
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE is_up = true) AS up_count
                    FROM cstrike.sla_checks
                    WHERE round_id = :round_id
                """),
                {"round_id": latest_row.id},
            )
            sla_row = sla.fetchone()
            if sla_row and sla_row.total > 0:
                success_rate = round(sla_row.up_count / sla_row.total * 100, 1)

        return {
            "scoring_round": current_round,
            "total_rounds": total_rounds,
            "scoring_success_rate": success_rate,
        }
    except Exception:
        return {"scoring_round": 0, "total_rounds": 0, "scoring_success_rate": 0.0}


async def _fetch_container_stats(url: str) -> dict:
    """deploy-service에서 전체/실행중 컨테이너 수 조회."""
    try:
        client = ExternalClient(url)
        data = await client.get("/api/stats")
        return {
            "total_containers": data.get("total", 0),
            "running_containers": data.get("running", 0),
        }
    except Exception:
        return {"total_containers": 0, "running_containers": 0}


# ── 엔드포인트 ────────────────────────────────────────────────

@router.get("/stats", response_model=DashboardStatsResponse)
async def get_dashboard_stats(
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """종합 대시보드 통계를 반환한다.

    실제 존재하는 외부 시스템의 health, 채점/컨테이너 통계, DB 집계를
    병렬로 조회하여 단일 응답으로 반환한다.
    """
    # 외부 시스템 health 병렬 조회
    health_tasks = [
        _fetch_health(url, name)
        for name, url in _EXTERNAL_SYSTEMS.items()
    ]

    # 채점 통계(DB 직접) / 컨테이너 통계(deploy-service) 병렬 조회
    scoring_task = _fetch_scoring_stats_from_db(db)
    container_task = _fetch_container_stats(settings.DEPLOY_SERVICE_URL)

    # DB 집계 쿼리
    open_tickets_query = select(func.count()).select_from(Ticket).where(
        Ticket.status == "open"
    )
    released_packs_query = select(func.count()).select_from(VulnpackSchedule).where(
        VulnpackSchedule.status == "released"
    )
    # 활성 팀 = 승인된(approved) 팀. 대회가 여러 개여도 전체 합산한다.
    active_teams_query = select(func.count()).select_from(Team).where(
        Team.status == "approved"
    )

    results = await asyncio.gather(
        *health_tasks,
        scoring_task,
        container_task,
        db.execute(open_tickets_query),
        db.execute(released_packs_query),
        db.execute(active_teams_query),
        return_exceptions=True,
    )

    # 결과 분리
    system_count = len(_EXTERNAL_SYSTEMS)
    health_items: list[SystemHealthItem] = []
    for i in range(system_count):
        item = results[i]
        if isinstance(item, Exception):
            name = list(_EXTERNAL_SYSTEMS.keys())[i]
            health_items.append(SystemHealthItem(name=name, status="unknown"))
        else:
            health_items.append(item)

    scoring_stats = results[system_count] if not isinstance(results[system_count], Exception) else {
        "scoring_round": 0, "total_rounds": 0, "scoring_success_rate": 0.0,
    }
    container_stats = results[system_count + 1] if not isinstance(results[system_count + 1], Exception) else {
        "total_containers": 0, "running_containers": 0,
    }

    open_tickets = results[system_count + 2].scalar() if not isinstance(results[system_count + 2], Exception) else 0
    released_packs = results[system_count + 3].scalar() if not isinstance(results[system_count + 3], Exception) else 0
    active_teams = results[system_count + 4].scalar() if not isinstance(results[system_count + 4], Exception) else 0

    return DashboardStatsResponse(
        active_teams=active_teams or 0,
        scoring_round=scoring_stats["scoring_round"],
        total_rounds=scoring_stats["total_rounds"],
        open_tickets=open_tickets or 0,
        current_vulnpack=released_packs or 0,
        system_health=health_items,
        scoring_success_rate=scoring_stats["scoring_success_rate"],
        total_containers=container_stats["total_containers"],
        running_containers=container_stats["running_containers"],
    )
