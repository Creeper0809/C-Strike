"""취약점팩 스케줄 API 라우터 --- 팩 CRUD 및 수동 공개."""

from datetime import datetime, timezone
from uuid import UUID as PyUUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, update, text, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.api.deps import get_current_operator
from app.api.deploy import PIPELINE_STAGES
from app.models.operator import Operator
from app.models.vulnpack import VulnpackSchedule
from app.models.vuln_service import VulnService
from app.models.deploy import DeployPipeline, DeployStage
from app.models.team import Team
from app.schemas.vulnpack import VulnpackCreate, VulnpackUpdate, VulnpackResponse
from app.utils.audit import record_audit

router = APIRouter(tags=["취약점팩"])


# ── 헬퍼 ─────────────────────────────────────────────────────

async def _resolve_service_names(
    db: AsyncSession, service_ids: set,
) -> dict:
    """서비스 UUID 집합 → {str(id): name} 매핑을 반환한다."""
    if not service_ids:
        return {}
    result = await db.execute(
        select(VulnService.id, VulnService.name).where(
            VulnService.id.in_(service_ids)
        )
    )
    return {str(row.id): row.name for row in result.all()}


def _to_response(pack: VulnpackSchedule, svc_names: dict | None = None) -> VulnpackResponse:
    """VulnpackSchedule ORM 객체를 VulnpackResponse로 변환한다."""
    resp = VulnpackResponse.model_validate(pack)
    if svc_names:
        resp.service_names = {str(sid): svc_names.get(str(sid), "?") for sid in pack.service_ids}
    return resp


async def _get_pack_or_404(db: AsyncSession, pack_id: str) -> VulnpackSchedule:
    """ID로 취약점팩을 조회하거나 404를 발생시킨다."""
    result = await db.execute(
        select(VulnpackSchedule).where(VulnpackSchedule.id == pack_id)
    )
    pack = result.scalar_one_or_none()
    if pack is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="취약점팩을 찾을 수 없습니다.",
        )
    return pack


def _str_ids_to_uuids(service_ids: list[str]) -> list[PyUUID]:
    """문자열 UUID 리스트를 UUID 객체 리스트로 변환한다."""
    try:
        return [PyUUID(sid) for sid in service_ids]
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="유효하지 않은 서비스 ID 형식이 포함되어 있습니다.",
        )


# ── 공통 헬퍼: 수동/자동 공개 공용 ─────────────────────────────

# 카테고리 코드 3자 매핑 — 봇 problem.py의 _category_icon과 맞춤
_CATEGORY_SHORT = {
    "web": "WEB", "pwn": "PWN", "pwnable": "PWN",
    "crypto": "CRY", "cryptography": "CRY",
    "rev": "REV", "reversing": "REV", "reverse": "REV",
    "forensic": "FOR", "forensics": "FOR",
    "misc": "MSC", "network": "NET",
}


def _problem_no_for(category: str | None, pack_number: int, idx: int) -> str:
    """`WEB-01-02` 같은 카탈로그 번호를 생성한다.

    pack_number는 1부터, idx는 pack 내 서비스 순번(0부터).
    카테고리가 비어있으면 MSC로 폴백.
    """
    key = (category or "misc").lower().strip()
    short = _CATEGORY_SHORT.get(key, key.upper()[:3] or "MSC")
    return f"{short}-{max(int(pack_number), 1):02d}-{idx + 1:02d}"


async def _upsert_problem_for_service(
    db: AsyncSession,
    svc: VulnService,
    pack: VulnpackSchedule,
    idx: int,
) -> None:
    """cstrike.problem 테이블에 서비스 하나를 공개 문제로 upsert.

    디스코드 봇 `/문제목록`/`/문제`가 읽는 유일한 소스이며, 운영포털의 vuln_services
    와는 별도 테이블이다. 취약점팩 release 흐름에서 이 함수가 브리지 역할을 한다.
    """
    category = (svc.category or "misc").upper().strip() or "MISC"
    problem_no = _problem_no_for(svc.category, pack.pack_number, idx)
    await db.execute(
        text(
            """
            INSERT INTO cstrike.problem (
                problem_no, title, category, score, difficulty,
                description, access_url, download_url, created_at, updated_at
            ) VALUES (
                :problem_no, :title, :category, :score, :difficulty,
                :description, NULL, NULL, NOW(), NOW()
            )
            ON CONFLICT (problem_no) DO UPDATE SET
                title = EXCLUDED.title,
                category = EXCLUDED.category,
                score = EXCLUDED.score,
                difficulty = EXCLUDED.difficulty,
                description = EXCLUDED.description,
                updated_at = NOW()
            """
        ),
        {
            "problem_no": problem_no,
            "title": svc.name or problem_no,
            "category": category,
            "score": getattr(svc, "score", None) or 100,
            "difficulty": getattr(svc, "difficulty", None) or "Easy",
            "description": svc.description,
        },
    )


async def _delete_problems_for_pack(
    db: AsyncSession, pack: VulnpackSchedule,
) -> None:
    """삭제되는 팩에 속한 모든 서비스의 problem 레코드 제거."""
    for idx, sid in enumerate(pack.service_ids or []):
        svc = await db.get(VulnService, sid)
        if svc is None:
            continue
        problem_no = _problem_no_for(svc.category, pack.pack_number, idx)
        await db.execute(
            text("DELETE FROM cstrike.problem WHERE problem_no = :pn"),
            {"pn": problem_no},
        )


async def _get_system_operator(db: AsyncSession) -> Operator:
    """자동 공개 시 actor로 사용할 시스템 operator(admin)를 조회한다.

    record_audit와 DeployPipeline.triggered_by가 nullable이 아니므로,
    자동 공개 경로에서도 실존하는 operator를 actor로 지정해야 한다.
    audit action prefix('system.vulnpack.auto_release')로 수동/자동을 구분한다.
    """
    result = await db.execute(
        select(Operator).where(Operator.username == "admin")
    )
    op = result.scalar_one_or_none()
    if op is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="시스템 operator(admin) 계정을 찾을 수 없습니다.",
        )
    return op


async def _execute_release(
    pack: VulnpackSchedule,
    db: AsyncSession,
    operator: Operator | None,
    request_ip: str | None,
    trigger: str,
) -> None:
    """취약점팩 공개 실행 (수동/자동 공용).

    1) status='scheduled' 가드 (멱등성)
    2) released 상태 전환 + released_by(수동은 operator.id, 자동은 NULL) + actual_release_at
    3) audit 기록 — 수동은 ops.vulnpack.release, 자동은 system.vulnpack.auto_release
    4) pack.service_ids 각각에 배포 파이프라인 생성 + deploy-service 호출

    operator가 None이면(자동 공개) 시스템 operator(admin)를 조회해
    record_audit/triggered_by의 actor로 사용한다. 단 released_by는
    의미 보존을 위해 NULL로 남긴다(수동 공개만 운영자 id 기록).
    """
    if pack.status != "scheduled":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="scheduled 상태의 팩만 공개할 수 있습니다.",
        )

    actual_operator = operator if operator is not None else await _get_system_operator(db)
    released_by_id = operator.id if operator is not None else None
    now = datetime.now(timezone.utc)

    await db.execute(
        update(VulnpackSchedule)
        .where(VulnpackSchedule.id == pack.id)
        .values(
            status="released",
            released_by=released_by_id,
            actual_release_at=now,
        )
    )

    audit_action = (
        "ops.vulnpack.release" if trigger == "manual" else "system.vulnpack.auto_release"
    )
    await record_audit(
        db, actual_operator, audit_action,
        "vulnpack", pack.id,
        {"pack_number": pack.pack_number, "trigger": trigger},
        request_ip,
    )
    await db.commit()
    await db.refresh(pack)

    # 배포 파이프라인 생성 + deploy-service 호출
    import httpx

    for idx, sid in enumerate(pack.service_ids):
        svc = await db.get(VulnService, sid)
        if not svc or svc.status != "active" or not svc.docker_image:
            continue

        # cstrike.problem 브리지 upsert — 디스코드 봇 /문제목록이 읽는 테이블.
        # deploy 성공/실패와 무관하게 active 서비스는 문제 카탈로그로 공개한다.
        await _upsert_problem_for_service(db, svc, pack, idx)
        await db.commit()

        teams_stmt = select(Team).where(
            Team.competition_id == pack.competition_id,
            Team.status == "approved",
        )
        teams_result = await db.execute(teams_stmt)
        teams = teams_result.scalars().all()
        team_list = [
            {"team_id": str(t.id), "team_code": t.team_code, "name": t.name,
             "subnet": t.subnet, "gateway_ip": getattr(t, 'gateway_ip', None),
             "competition_id": str(t.competition_id)}
            for t in teams if t.subnet
        ]
        if not team_list:
            continue

        pipeline = DeployPipeline(
            service_id=sid, triggered_by=actual_operator.id, status="running",
            current_stage="register", started_at=datetime.now(timezone.utc),
        )
        db.add(pipeline)
        await db.flush()

        for stage_def in PIPELINE_STAGES:
            db.add(DeployStage(
                pipeline_id=pipeline.id, stage_name=stage_def["stage_name"],
                stage_order=stage_def["stage_order"], status="pending",
            ))
        await db.commit()

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                await client.post(
                    f"{settings.DEPLOY_SERVICE_URL}/deploy/teams",
                    json={
                        "pipeline_id": str(pipeline.id),
                        "service": {
                            "service_id": str(svc.id), "name": svc.name,
                            "docker_image": svc.docker_image,
                            "container_port": svc.container_port or 80,
                            "health_check_endpoint": svc.health_check_endpoint,
                        },
                        "teams": team_list,
                    },
                    headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
                )
        except Exception as e:
            pipeline.status = "failed"
            pipeline.error_detail = f"deploy-service 호출 실패: {e}"
            await db.commit()


# ── 엔드포인트 ────────────────────────────────────────────────

@router.get("/")
async def list_vulnpacks(
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """취약점팩 목록을 조회한다. pack_number 오름차순 전체 조회."""
    result = await db.execute(
        select(VulnpackSchedule)
        .order_by(VulnpackSchedule.pack_number.asc())
    )
    packs = list(result.scalars().all())

    all_svc_ids: set = set()
    for p in packs:
        all_svc_ids.update(p.service_ids)
    svc_names = await _resolve_service_names(db, all_svc_ids)

    return [_to_response(p, svc_names) for p in packs]


@router.post("/", response_model=VulnpackResponse, status_code=status.HTTP_201_CREATED)
async def create_vulnpack(
    body: VulnpackCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """새 취약점팩을 등록한다. 초기 상태는 scheduled."""
    uuid_ids = _str_ids_to_uuids(body.service_ids)

    pack = VulnpackSchedule(
        pack_number=body.pack_number,
        label=body.label,
        service_ids=uuid_ids,
        scheduled_offset_minutes=body.scheduled_offset_minutes,
        status="scheduled",
    )
    db.add(pack)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.vulnpack.create",
        "vulnpack", pack.id,
        {"pack_number": pack.pack_number, "label": pack.label},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(pack)

    svc_names = await _resolve_service_names(db, set(pack.service_ids))
    return _to_response(pack, svc_names)


@router.patch("/{pack_id}", response_model=VulnpackResponse)
async def update_vulnpack(
    pack_id: str,
    body: VulnpackUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """취약점팩을 수정한다. scheduled 상태에서만 가능."""
    pack = await _get_pack_or_404(db, pack_id)

    if pack.status != "scheduled":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="scheduled 상태의 팩만 수정할 수 있습니다.",
        )

    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="수정할 항목이 없습니다.",
        )

    # service_ids가 포함된 경우 UUID 변환
    if "service_ids" in update_data:
        update_data["service_ids"] = _str_ids_to_uuids(update_data["service_ids"])

    await db.execute(
        update(VulnpackSchedule)
        .where(VulnpackSchedule.id == pack_id)
        .values(**update_data)
    )

    await record_audit(
        db, current_operator, "ops.vulnpack.update",
        "vulnpack", pack.id,
        {"updated_fields": list(update_data.keys())},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(pack)

    svc_names = await _resolve_service_names(db, set(pack.service_ids))
    return _to_response(pack, svc_names)


@router.post("/{pack_id}/release", response_model=VulnpackResponse)
async def release_vulnpack(
    pack_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """취약점팩을 수동으로 공개한다. released 상태로 전환."""
    pack = await _get_pack_or_404(db, pack_id)

    await _execute_release(
        pack=pack,
        db=db,
        operator=current_operator,
        request_ip=request.client.host if request.client else None,
        trigger="manual",
    )

    svc_names = await _resolve_service_names(db, set(pack.service_ids))
    return _to_response(pack, svc_names)


@router.delete("/{pack_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_vulnpack(
    pack_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """취약점팩을 삭제한다. scheduled/released/cancelled 모든 상태에서 가능.

    released 상태의 팩을 삭제해도 이미 생성된 DeployPipeline과 배포된 팀별
    컨테이너는 별도 영역(배포 관리/컨테이너)에서 관리하므로 건드리지 않는다.
    운영자가 공개 스케줄 기록만 제거하고 싶은 경우를 위한 순수 레코드 삭제다.
    """
    pack = await _get_pack_or_404(db, pack_id)

    # cstrike.problem 브리지 — 팩에 묶인 문제 카탈로그를 함께 정리한다.
    await _delete_problems_for_pack(db, pack)

    await record_audit(
        db, current_operator, "ops.vulnpack.delete",
        "vulnpack", pack.id,
        {"pack_number": pack.pack_number, "status_at_delete": pack.status},
        request.client.host if request.client else None,
    )
    await db.delete(pack)
    await db.commit()
