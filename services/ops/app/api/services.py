"""취약 서비스 API 라우터 --- CRUD 및 빌드/배포 관리."""

import io
import re
import zipfile
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File, status
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from minio import Minio

from app.config import settings
from app.database import get_db
from app.api.deps import get_current_operator
from app.models.operator import Operator
from app.models.vuln_service import VulnService
from app.schemas.service import (
    ServiceCreate,
    ServiceUpdate,
    ServiceResponse,
)
from app.utils.audit import record_audit
from app.utils.flag_slots import (
    DEFAULT_FLAG_FORMAT,
    build_default_flag_slots,
    calculate_total_flag_points,
    derive_service_difficulty,
    normalize_flag_slots,
)
from app.utils.healthcheck_scenarios import normalize_healthcheck_scenarios


# ── Dockerfile HEALTHCHECK 파서 (Task 2) ─────────────────────

_HEALTHCHECK_URL_RE = re.compile(
    r"https?://[^/\s\"']+(/[^\s\"'|&`]*)",
    re.IGNORECASE,
)


def parse_dockerfile_healthcheck(dockerfile_content: str) -> str | None:
    """Dockerfile의 HEALTHCHECK 지시어에서 경로만 추출한다.

    지원 예시:
        HEALTHCHECK CMD curl -f http://localhost:8080/healthz || exit 1
        HEALTHCHECK --interval=30s CMD wget -qO- http://127.0.0.1/ping
        HEALTHCHECK CMD curl http://localhost/api/v1/health

    Returns:
        슬래시로 시작하는 경로 문자열, 없거나 NONE이면 None.
    """
    for raw_line in dockerfile_content.splitlines():
        stripped = raw_line.strip()
        if not stripped.upper().startswith("HEALTHCHECK"):
            continue
        # HEALTHCHECK NONE은 명시적으로 헬스체크 비활성
        if stripped.upper().replace(" ", "").startswith("HEALTHCHECKNONE"):
            return None
        match = _HEALTHCHECK_URL_RE.search(stripped)
        if not match:
            continue
        path = match.group(1)
        # 뒤에 붙은 리다이렉션/파이프/따옴표 정리
        path = path.split("||")[0].split("&&")[0].split("|")[0]
        path = path.strip().rstrip("\"'")
        if path.startswith("/"):
            return path
    return None


# 빌드 컨텍스트 허용 확장자
BUILD_CONTEXT_EXTENSIONS = {
    ".py", ".c", ".cpp", ".h", ".rs", ".go", ".java", ".js", ".ts",
    ".html", ".css", ".sql", ".json", ".yaml", ".yml", ".toml",
    ".txt", ".md", ".conf", ".cfg", ".ini", ".sh", ".bash",
    ".dockerfile", ".xml", ".rb", ".php", ".pl",
    ".zip", ".tar", ".gz",
    ".png", ".jpg", ".jpeg", ".gif", ".svg",
    ".pcap", ".pcapng", ".elf", ".bin",
    ".so",
}

BLOCKED_EXTENSIONS = {
    ".exe", ".bat", ".cmd", ".ps1",
    ".msi", ".dll", ".dylib",
    ".asp", ".aspx", ".cgi",
}

MAX_FILE_SIZE = 50 * 1024 * 1024   # 50MB per file
MAX_TOTAL_SIZE = 200 * 1024 * 1024  # 200MB total


def _get_minio_client() -> Minio:
    return Minio(
        settings.MINIO_ENDPOINT,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=False,
    )


def validate_build_filename(filename: str) -> str | None:
    """파일명 보안 검증. 에러 시 메시지 반환, 정상이면 None."""
    if "\x00" in filename:
        return "유효하지 않은 파일명"
    if ".." in filename or "\\" in filename:
        return "유효하지 않은 파일명"
    if filename.startswith("/"):
        return "유효하지 않은 파일명"
    basename = filename.rsplit("/", 1)[-1]
    if not basename:
        return "유효하지 않은 파일명"
    if basename == "Dockerfile" or basename.startswith("Dockerfile."):
        return None
    ext = ""
    if "." in basename:
        ext = "." + basename.rsplit(".", 1)[-1].lower()
    if ext in BLOCKED_EXTENSIONS:
        return f"{ext} 파일은 차단되었습니다"
    if ext and ext not in BUILD_CONTEXT_EXTENSIONS:
        return f"{ext} 파일은 허용되지 않습니다"
    return None

router = APIRouter(tags=["취약 서비스"])


# ── 헬퍼 ─────────────────────────────────────────────────────


async def _resolve_operator_names(
    db: AsyncSession, operator_ids: set[UUID],
) -> dict[UUID, str]:
    """operator UUID 집합 → {id: display_name} 매핑을 반환한다."""
    if not operator_ids:
        return {}
    result = await db.execute(
        select(Operator.id, Operator.display_name).where(
            Operator.id.in_(operator_ids)
        )
    )
    return {row.id: row.display_name for row in result.all()}


def _to_response(
    service: VulnService,
    name_map: dict[UUID, str] | None = None,
) -> ServiceResponse:
    """VulnService ORM 객체를 ServiceResponse로 변환한다."""
    resp = ServiceResponse.model_validate(service)
    resp.flag_slots = normalize_flag_slots(
        service.flag_slots,
        fallback_score=service.score or 100,
        fallback_difficulty=service.difficulty or "Easy",
    )
    resp.healthcheck_scenarios = normalize_healthcheck_scenarios(service.healthcheck_scenarios)
    resp.score = calculate_total_flag_points(resp.flag_slots)
    resp.difficulty = derive_service_difficulty(resp.flag_slots, service.difficulty or "Easy")
    if name_map:
        resp.registered_by_name = name_map.get(service.registered_by)
        if service.approved_by:
            resp.approved_by_name = name_map.get(service.approved_by)
    return resp


async def _get_service_or_404(db: AsyncSession, service_id: str) -> VulnService:
    """ID로 서비스를 조회하거나 404를 발생시킨다."""
    result = await db.execute(
        select(VulnService).where(VulnService.id == service_id)
    )
    service = result.scalar_one_or_none()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="서비스를 찾을 수 없습니다.",
        )
    return service


# ── 엔드포인트 ────────────────────────────────────────────────

@router.get("/")
async def list_services(
    status_filter: str | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """서비스 목록을 페이지네이션으로 조회한다."""
    base_query = select(VulnService)
    count_query = select(func.count()).select_from(VulnService)

    if status_filter:
        base_query = base_query.where(VulnService.status == status_filter)
        count_query = count_query.where(VulnService.status == status_filter)

    offset = (page - 1) * limit
    items_result = await db.execute(
        base_query.order_by(VulnService.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    total_result = await db.execute(count_query)

    services = items_result.scalars().all()
    total = total_result.scalar() or 0

    # operator UUID → display_name 일괄 조회
    op_ids: set[UUID] = set()
    for svc in services:
        op_ids.add(svc.registered_by)
        if svc.approved_by:
            op_ids.add(svc.approved_by)
    name_map = await _resolve_operator_names(db, op_ids)

    items = [_to_response(row, name_map) for row in services]
    return {"items": items, "total": total, "page": page, "limit": limit}


@router.post("/", response_model=ServiceResponse, status_code=status.HTTP_201_CREATED)
async def create_service(
    body: ServiceCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """새 취약 서비스를 등록한다. 초기 상태는 draft."""
    if body.env_type == "image" and not body.docker_image:
        raise HTTPException(400, "Docker 이미지 모드에서는 docker_image가 필수입니다")
    if body.env_type == "connection_info" and not (body.connection_info or "").strip():
        raise HTTPException(400, "접속 정보 모드에서는 connection_info가 필수입니다")
    if body.env_type not in ("image", "dockerfile", "connection_info"):
        raise HTTPException(400, "env_type은 'image', 'dockerfile', 'connection_info'만 허용됩니다")

    # 대회 존재 여부 사전 검증 — FK 위반 500 방지
    if body.competition_id is not None:
        from app.models.competition import Competition
        comp = await db.get(Competition, body.competition_id)
        if comp is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="해당 대회가 존재하지 않습니다.",
            )

    # dockerfile 모드는 ID 기반으로 docker_image를 자동 생성한다.
    # 빌드 전에도 non-null을 보장해 deploy-service(ServiceInput.docker_image: str) 422를 방지.
    new_id = uuid4()
    auto_image = (
        f"cstrike-vuln-{new_id}:latest"
        if body.env_type == "dockerfile"
        else body.docker_image if body.env_type == "image" else None
    )

    try:
        normalized_slots = normalize_flag_slots(
            body.flag_slots,
            fallback_score=100,
            fallback_difficulty=body.difficulty or "Easy",
        )
        normalized_healthcheck_scenarios = normalize_healthcheck_scenarios(body.healthcheck_scenarios)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    service = VulnService(
        id=new_id,
        name=body.name,
        description=body.description,
        connection_info=body.connection_info,
        category=body.category,
        competition_id=body.competition_id,
        docker_image=auto_image,
        docker_compose_config=body.docker_compose_config,
        exposed_ports=body.exposed_ports,
        flag_format=body.flag_format or DEFAULT_FLAG_FORMAT,
        flag_slots=normalized_slots,
        health_check_endpoint=body.health_check_endpoint,
        healthcheck_scenarios=normalized_healthcheck_scenarios,
        env_type=body.env_type,
        container_port=body.container_port if body.env_type != "connection_info" else None,
        status="draft",
        registered_by=current_operator.id,
        score=calculate_total_flag_points(normalized_slots),
        difficulty=derive_service_difficulty(normalized_slots, body.difficulty or "Easy"),
    )
    db.add(service)
    await db.flush()

    await record_audit(
        db, current_operator, "ops.service.create",
        "service", service.id,
        {"name": service.name},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(service)

    name_map = {current_operator.id: current_operator.display_name}
    return _to_response(service, name_map)


@router.get("/{service_id}", response_model=ServiceResponse)
async def get_service(
    service_id: str,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """서비스 상세 정보를 조회한다."""
    service = await _get_service_or_404(db, service_id)
    op_ids = {service.registered_by}
    if service.approved_by:
        op_ids.add(service.approved_by)
    name_map = await _resolve_operator_names(db, op_ids)
    return _to_response(service, name_map)


@router.patch("/{service_id}", response_model=ServiceResponse)
async def update_service(
    service_id: str,
    body: ServiceUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """서비스를 수정한다.

    draft 상태: 모든 필드 수정 가능.
    active 상태: competition_id / flag_slots / health_check_endpoint / healthcheck_scenarios /
        connection_info
        같은 운영 메타만 수정 허용. 이름이나 이미지 등은 빌드 재실행이 필요하므로
        draft 경유를 강제한다.
    """
    service = await _get_service_or_404(db, service_id)

    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="수정할 항목이 없습니다.",
        )

    if service.status != "draft":
        # competition_id / flag_slots / healthcheck_* 는 빌드와 무관한 메타라 active 상태에서도 허용.
        non_meta_fields = set(update_data.keys()) - {
            "competition_id",
            "flag_slots",
            "health_check_endpoint",
            "healthcheck_scenarios",
            "connection_info",
        }
        if non_meta_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="draft 상태가 아닌 서비스는 대회·플래그 슬롯·헬스체크 설정만 수정할 수 있습니다.",
            )

    effective_env_type = update_data.get("env_type", service.env_type)
    effective_docker_image = update_data.get("docker_image", service.docker_image)
    effective_connection_info = update_data.get("connection_info", service.connection_info)

    if effective_env_type not in ("image", "dockerfile", "connection_info"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="env_type은 'image', 'dockerfile', 'connection_info'만 허용됩니다",
        )
    if effective_env_type == "image" and not effective_docker_image:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Docker 이미지 모드에서는 docker_image가 필수입니다.",
        )
    if effective_env_type == "connection_info" and not str(effective_connection_info or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="접속 정보 모드에서는 connection_info가 필수입니다.",
        )
    if effective_env_type == "connection_info":
        update_data["docker_image"] = None
        update_data["container_port"] = None

    # 대회 존재 여부 사전 검증 — FK 위반 500 방지
    if "competition_id" in update_data and update_data["competition_id"] is not None:
        from app.models.competition import Competition
        comp = await db.get(Competition, update_data["competition_id"])
        if comp is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="해당 대회가 존재하지 않습니다.",
            )

    if "flag_slots" in update_data:
        try:
            normalized_slots = normalize_flag_slots(
                update_data["flag_slots"],
                fallback_score=service.score,
                fallback_difficulty=service.difficulty or "Easy",
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc
        update_data["flag_slots"] = normalized_slots
        update_data["score"] = calculate_total_flag_points(normalized_slots)
        update_data["difficulty"] = derive_service_difficulty(normalized_slots, service.difficulty or "Easy")
        update_data["flag_format"] = DEFAULT_FLAG_FORMAT

    if "healthcheck_scenarios" in update_data:
        try:
            update_data["healthcheck_scenarios"] = normalize_healthcheck_scenarios(
                update_data["healthcheck_scenarios"]
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc

    if "flag_format" in update_data and not update_data["flag_format"]:
        update_data["flag_format"] = DEFAULT_FLAG_FORMAT

    await db.execute(
        update(VulnService)
        .where(VulnService.id == service_id)
        .values(**update_data)
    )

    # score/difficulty 변경 시 cstrike.problem 카탈로그도 동기화.
    # release된 팩들의 problem_no를 찾아 값만 갱신한다. 운영자가 서비스 편집으로
    # 점수를 바꾸면 /문제목록에 즉시 반영되도록 한다.
    if "score" in update_data or "difficulty" in update_data or "flag_slots" in update_data:
        await db.flush()
        await db.refresh(service)
        from app.api.vulnpacks import _CATEGORY_SHORT
        cat = (service.category or "misc").lower().strip()
        short = _CATEGORY_SHORT.get(cat, cat.upper()[:3] or "MSC")
        pack_rows = (await db.execute(
            text(
                "SELECT pack_number, service_ids FROM cstrike.vulnpack_schedules "
                "WHERE status='released' AND CAST(:sid AS uuid) = ANY(service_ids)"
            ),
            {"sid": str(service.id)},
        )).fetchall()
        for pack_number, service_ids_list in pack_rows:
            try:
                idx = [str(sid) for sid in service_ids_list].index(str(service.id))
            except ValueError:
                continue
            problem_no = f"{short}-{int(pack_number):02d}-{idx + 1:02d}"
            await db.execute(
                text(
                    "UPDATE cstrike.problem "
                    "SET score = :s, difficulty = :d, title = :t, category = :c, "
                    "    description = :desc, updated_at = NOW() "
                    "WHERE problem_no = :pn"
                ),
                {
                    "s": service.score,
                    "d": service.difficulty,
                    "t": service.name,
                    "c": cat.upper()[:10] or "MISC",
                    "desc": service.description,
                    "pn": problem_no,
                },
            )

    await record_audit(
        db, current_operator, "ops.service.update",
        "service", service.id,
        {"updated_fields": list(update_data.keys())},
        request.client.host if request.client else None,
    )
    await db.commit()
    await db.refresh(service)

    op_ids = {service.registered_by}
    if service.approved_by:
        op_ids.add(service.approved_by)
    name_map = await _resolve_operator_names(db, op_ids)
    return _to_response(service, name_map)


_DELETABLE_SERVICE_STATUSES = {"draft", "active"}


@router.delete("/{service_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_service(
    service_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """서비스를 완전히 삭제한다. draft와 active 상태 모두 삭제 가능.

    active 서비스 삭제 흐름:
      1) deploy-service로 teardown 호출 → 모든 팀 컨테이너 중지/삭제 + 호스트 포트 해제 + 빌드 이미지 제거
      2) FK 제약이 RESTRICT인 자식 레코드 삭제 (flags, sla_checks, team_services)
      3) SET NULL 자식 레코드는 자동 처리 (flag_submissions)
      4) vuln_service DB 삭제

    draft 상태는 배포된 것이 없으므로 2~4 단계만 수행(1은 noop).
    teardown이 실패해도 DB 삭제는 강행 — 고아 컨테이너는 배포 관리에서 수동 정리 가능.
    """
    from sqlalchemy import delete as sql_delete, update as sql_update

    from app.models.deploy import DeployPipeline, DeployStage
    from app.models.flag import Flag, FlagSubmission
    from app.models.sla_check import SlaCheck
    from app.models.team_service import TeamService
    from app.models.emergency import EmergencyAction

    service = await _get_service_or_404(db, service_id)

    if service.status not in _DELETABLE_SERVICE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"현재 상태({service.status})에서는 삭제할 수 없습니다. (draft 또는 active 상태만 가능)",
        )

    running_pipeline_exists = await db.scalar(
        select(func.count())
        .select_from(DeployPipeline)
        .where(
            DeployPipeline.service_id == service.id,
            DeployPipeline.status == "running",
        )
    )
    if running_pipeline_exists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이 서비스의 배포 파이프라인이 아직 실행 중입니다. 배포 완료 또는 실패 후 다시 삭제해 주세요.",
        )

    teardown_summary: dict | None = None
    if service.status == "active":
        import httpx
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.delete(
                    f"{settings.DEPLOY_SERVICE_URL}/containers/service/{service_id}",
                    headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
                )
                if resp.status_code == 200:
                    teardown_summary = resp.json()
                else:
                    teardown_summary = {"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
        except Exception as e:
            teardown_summary = {"error": str(e)}

    pipeline_ids_subquery = (
        select(DeployPipeline.id)
        .where(DeployPipeline.service_id == service.id)
    )

    # FK 제약이 RESTRICT인 자식 레코드를 먼저 정리.
    # 순서:
    #   1) deploy_stages / deploy_pipelines
    #   2) sla_checks → flags → team_services (sla_checks가 team_services도 참조)
    await db.execute(
        sql_update(DeployPipeline)
        .where(DeployPipeline.rollback_of.in_(pipeline_ids_subquery))
        .values(rollback_of=None)
    )
    await db.execute(
        sql_delete(DeployStage).where(DeployStage.pipeline_id.in_(pipeline_ids_subquery))
    )
    await db.execute(
        sql_delete(DeployPipeline).where(DeployPipeline.service_id == service.id)
    )
    await db.execute(sql_delete(SlaCheck).where(SlaCheck.service_id == service_id))
    await db.execute(sql_delete(Flag).where(Flag.service_id == service_id))
    await db.execute(sql_delete(TeamService).where(TeamService.service_id == service_id))

    # emergency_actions.target_service_id는 nullable이므로 SET NULL
    try:
        await db.execute(
            sql_update(EmergencyAction)
            .where(EmergencyAction.target_service_id == service_id)
            .values(target_service_id=None)
        )
    except Exception:
        pass

    await record_audit(
        db, current_operator, "ops.service.delete",
        "service", service.id,
        {
            "name": service.name,
            "status_at_delete": service.status,
            "teardown": teardown_summary,
        },
        request.client.host if request.client else None,
    )
    await db.delete(service)
    await db.commit()


# ── 빌드 컨텍스트 관리 엔드포인트 ──────────────────────────────


@router.post("/{service_id}/build-files")
async def upload_build_files(
    service_id: str,
    files: list[UploadFile] = File(...),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """빌드 컨텍스트 파일 업로드."""
    service = await db.get(VulnService, service_id)
    if not service:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    if service.env_type != "dockerfile":
        raise HTTPException(400, "Dockerfile 모드 서비스만 빌드 파일을 업로드할 수 있습니다")

    mc = _get_minio_client()
    bucket = settings.MINIO_BUCKET
    if not mc.bucket_exists(bucket):
        mc.make_bucket(bucket)

    uploaded = []
    total_size = 0
    errors = []

    for f in files:
        err = validate_build_filename(f.filename)
        if err:
            errors.append({"filename": f.filename, "error": err})
            continue
        content = await f.read()
        if len(content) > MAX_FILE_SIZE:
            errors.append({"filename": f.filename, "error": f"파일 크기 초과 ({len(content)} > {MAX_FILE_SIZE})"})
            continue
        total_size += len(content)
        if total_size > MAX_TOTAL_SIZE:
            errors.append({"filename": f.filename, "error": "전체 파일 크기 합산 초과"})
            break
        object_name = f"build-context/{service_id}/{f.filename}"
        mc.put_object(bucket, object_name, io.BytesIO(content), length=len(content),
                      content_type=f.content_type or "application/octet-stream")
        uploaded.append(f.filename)

    # Dockerfile EXPOSE + HEALTHCHECK 자동 감지 (Task 2)
    detected_port = None
    detected_health = None
    for f_name in uploaded:
        if f_name == "Dockerfile" or f_name.endswith("/Dockerfile"):
            obj_name = f"build-context/{service_id}/{f_name}"
            response = mc.get_object(bucket, obj_name)
            dockerfile_content = response.read().decode("utf-8", errors="replace")
            response.close()
            response.release_conn()
            for line in dockerfile_content.splitlines():
                stripped = line.strip()
                if stripped.upper().startswith("EXPOSE"):
                    parts = stripped.split()
                    if len(parts) >= 2:
                        port_str = parts[1].split("/")[0]
                        if port_str.isdigit():
                            detected_port = int(port_str)
                            break
            # 같은 Dockerfile에서 HEALTHCHECK 경로도 추출
            detected_health = parse_dockerfile_healthcheck(dockerfile_content)
            break

    needs_commit = False
    if detected_port and not service.container_port:
        service.container_port = detected_port
        needs_commit = True
    # 관리자가 수동 입력한 헬스체크 경로가 있으면 덮어쓰지 않는다 (수동 우선)
    if detected_health and not service.health_check_endpoint:
        service.health_check_endpoint = detected_health
        needs_commit = True
    if needs_commit:
        await db.commit()

    await record_audit(
        db, current_operator, "ops.service.build_files.upload",
        "service", service.id,
        {"service_id": service_id, "uploaded_count": len(uploaded), "error_count": len(errors)},
        request.client.host if request and request.client else None,
    )
    return {
        "uploaded": uploaded,
        "errors": errors,
        "detected_port": detected_port,
        "detected_health_endpoint": detected_health,
        "total_size": total_size,
    }


MAX_ARCHIVE_SIZE = 200 * 1024 * 1024       # ZIP 파일 자체 최대 200MB
MAX_EXTRACTED_TOTAL = 200 * 1024 * 1024    # 해제 후 총 파일 크기 200MB
MAX_ARCHIVE_FILE_COUNT = 1000              # zip bomb 방지: 최대 파일 수


@router.post("/{service_id}/build-archive")
async def upload_build_archive(
    service_id: str,
    file: UploadFile | None = File(None),
    archive: UploadFile | None = File(None),
    replace: bool = Query(True, description="True이면 기존 빌드 파일을 삭제 후 교체"),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """ZIP 아카이브로 빌드 컨텍스트를 일괄 업로드한다.

    - ZIP 파일 하나를 받아 서버에서 해제
    - 각 파일을 validate_build_filename()으로 검증
    - MinIO에 build-context/{service_id}/... 경로로 저장
    - replace=True(기본)이면 기존 파일 삭제 후 교체
    """
    service = await db.get(VulnService, service_id)
    if not service:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    if service.env_type != "dockerfile":
        raise HTTPException(400, "Dockerfile 모드 서비스만 빌드 파일을 업로드할 수 있습니다")

    upload = file or archive
    if upload is None:
        raise HTTPException(422, "ZIP 업로드 파일이 필요합니다")

    # --- ZIP 확장자 검증 ---
    archive_name = upload.filename or "unknown.zip"
    if not archive_name.lower().endswith(".zip"):
        raise HTTPException(400, ".zip 파일만 업로드할 수 있습니다")

    # --- ZIP 파일 읽기 & 크기 검증 ---
    archive_bytes = await upload.read()
    if len(archive_bytes) > MAX_ARCHIVE_SIZE:
        raise HTTPException(
            400,
            f"ZIP 파일 크기 초과 ({len(archive_bytes):,} > {MAX_ARCHIVE_SIZE:,} bytes)",
        )

    # --- ZIP 무결성 검증 ---
    if not zipfile.is_zipfile(io.BytesIO(archive_bytes)):
        raise HTTPException(400, "유효한 ZIP 파일이 아닙니다")

    mc = _get_minio_client()
    bucket = settings.MINIO_BUCKET
    if not mc.bucket_exists(bucket):
        mc.make_bucket(bucket)

    # --- replace 모드: 기존 파일 삭제 ---
    if replace:
        prefix = f"build-context/{service_id}/"
        existing = mc.list_objects(bucket, prefix=prefix, recursive=True)
        for obj in existing:
            mc.remove_object(bucket, obj.object_name)

    uploaded: list[str] = []
    errors: list[dict] = []
    total_size = 0

    with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as zf:
        members = zf.infolist()

        # --- zip bomb 방지: 파일 수 제한 ---
        if len(members) > MAX_ARCHIVE_FILE_COUNT:
            raise HTTPException(
                400,
                f"ZIP 내 파일 수 초과 ({len(members)} > {MAX_ARCHIVE_FILE_COUNT})",
            )

        for member in members:
            # 디렉터리 엔트리는 건너뛰기
            if member.is_dir():
                continue

            entry_name = member.filename

            # --- 경로 탐색 공격 방지 ---
            if ".." in entry_name or entry_name.startswith("/") or "\\" in entry_name:
                errors.append({"filename": entry_name, "error": "유효하지 않은 경로"})
                continue

            if "\x00" in entry_name:
                errors.append({"filename": entry_name, "error": "유효하지 않은 파일명"})
                continue

            # --- 파일명 보안 검증 ---
            err = validate_build_filename(entry_name)
            if err:
                errors.append({"filename": entry_name, "error": err})
                continue

            # --- 개별 파일 크기 검증 ---
            content = zf.read(member.filename)
            if len(content) > MAX_FILE_SIZE:
                errors.append({
                    "filename": entry_name,
                    "error": f"파일 크기 초과 ({len(content):,} > {MAX_FILE_SIZE:,})",
                })
                continue

            # --- 해제 후 총 크기 검증 ---
            total_size += len(content)
            if total_size > MAX_EXTRACTED_TOTAL:
                errors.append({"filename": entry_name, "error": "해제 후 전체 파일 크기 합산 초과"})
                break

            # --- MinIO 업로드 ---
            object_name = f"build-context/{service_id}/{entry_name}"
            mc.put_object(
                bucket,
                object_name,
                io.BytesIO(content),
                length=len(content),
                content_type="application/octet-stream",
            )
            uploaded.append(entry_name)

    # --- Dockerfile EXPOSE + HEALTHCHECK 자동 감지 (Task 2) ---
    detected_port = None
    detected_health = None
    for f_name in uploaded:
        if f_name == "Dockerfile" or f_name.endswith("/Dockerfile"):
            obj_name = f"build-context/{service_id}/{f_name}"
            response = mc.get_object(bucket, obj_name)
            dockerfile_content = response.read().decode("utf-8", errors="replace")
            response.close()
            response.release_conn()
            for line in dockerfile_content.splitlines():
                stripped = line.strip()
                if stripped.upper().startswith("EXPOSE"):
                    parts = stripped.split()
                    if len(parts) >= 2:
                        port_str = parts[1].split("/")[0]
                        if port_str.isdigit():
                            detected_port = int(port_str)
                            break
            detected_health = parse_dockerfile_healthcheck(dockerfile_content)
            break

    needs_commit = False
    if detected_port and not service.container_port:
        service.container_port = detected_port
        needs_commit = True
    # 관리자가 수동 입력한 헬스체크 경로가 있으면 덮어쓰지 않는다 (수동 우선)
    if detected_health and not service.health_check_endpoint:
        service.health_check_endpoint = detected_health
        needs_commit = True
    if needs_commit:
        await db.commit()

    # --- 감사 로그 ---
    await record_audit(
        db, current_operator, "ops.service.build_archive.upload",
        "service", service.id,
        {
            "service_id": service_id,
            "archive_name": archive_name,
            "uploaded_count": len(uploaded),
            "error_count": len(errors),
            "total_size": total_size,
            "replace": replace,
        },
        request.client.host if request and request.client else None,
    )

    return {
        "uploaded": uploaded,
        "errors": errors,
        "detected_port": detected_port,
        "detected_health_endpoint": detected_health,
        "total_size": total_size,
        "archive_name": archive_name,
    }


@router.get("/{service_id}/build-files")
async def list_build_files(
    service_id: str,
    current_operator: Operator = Depends(get_current_operator),
):
    """업로드된 빌드 컨텍스트 파일 목록."""
    mc = _get_minio_client()
    prefix = f"build-context/{service_id}/"
    objects = mc.list_objects(settings.MINIO_BUCKET, prefix=prefix, recursive=True)
    files = []
    for obj in objects:
        relative_path = obj.object_name[len(prefix):]
        if relative_path:
            files.append({"filename": relative_path, "size": obj.size,
                          "last_modified": obj.last_modified.isoformat() if obj.last_modified else None})
    return {"service_id": service_id, "files": files}


@router.delete("/{service_id}/build-files/{filename:path}")
async def delete_build_file(
    service_id: str,
    filename: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """빌드 파일 삭제."""
    mc = _get_minio_client()
    mc.remove_object(settings.MINIO_BUCKET, f"build-context/{service_id}/{filename}")
    await record_audit(
        db, current_operator, "ops.service.build_files.delete",
        "service", None,
        {"service_id": service_id, "filename": filename},
        request.client.host if request.client else None,
    )
    return {"status": "deleted", "filename": filename}


@router.post("/{service_id}/build")
async def trigger_build(
    service_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """Docker 이미지 빌드 트리거 → deploy-service 동기 호출.

    deploy-service가 빌드 완료까지 대기 후 응답하므로 응답 시점에 성공/실패가 확정된다.
    무한 "building" 상태를 방지하기 위해 Redis pub/sub 콜백이 아닌 응답 바디로 상태를 반영한다.
    성공 시 status=active 자동 승격, 실패 시 status=draft 유지.
    """
    service = await db.get(VulnService, service_id)
    if not service:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    if service.env_type != "dockerfile":
        raise HTTPException(400, "Dockerfile 모드 서비스만 빌드할 수 있습니다")

    now = datetime.now(timezone.utc)
    service.build_status = "building"
    service.build_started_at = now
    service.build_completed_at = None
    await db.commit()

    import httpx

    # 타임아웃 순서 (바깥 > 안쪽):
    #   nginx /api/ proxy_read_timeout = 900s
    #   ops-backend httpx 타임아웃     = 600s   ← 여기
    #   deploy-service BUILD_TIMEOUT   = 300s (Docker SDK timeout)
    # 바깥 타임아웃이 더 길어야 내부 에러가 정상적으로 전달된다.
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{settings.DEPLOY_SERVICE_URL}/build/{service_id}",
                headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
            )
    except httpx.TimeoutException:
        service.build_status = "failed"
        service.build_completed_at = datetime.now(timezone.utc)
        service.build_log = "빌드 타임아웃 — deploy-service 응답 없음 (10분 초과)"
        await db.commit()
        raise HTTPException(504, "빌드 타임아웃: 10분 내 완료되지 않았습니다.")
    except Exception as e:
        service.build_status = "failed"
        service.build_completed_at = datetime.now(timezone.utc)
        service.build_log = f"deploy-service 호출 실패: {e}"
        await db.commit()
        raise HTTPException(502, f"deploy-service 호출 실패: {e}")

    if resp.status_code != 200:
        service.build_status = "failed"
        service.build_completed_at = datetime.now(timezone.utc)
        service.build_log = f"deploy-service HTTP {resp.status_code}: {resp.text[:500]}"
        await db.commit()
        raise HTTPException(502, f"deploy-service 빌드 실패 ({resp.status_code}): {resp.text[:200]}")

    result = resp.json()
    final_status = result.get("build_status", "failed")
    service.build_status = final_status
    service.build_completed_at = datetime.now(timezone.utc)

    if final_status == "success":
        if result.get("docker_image"):
            service.docker_image = result["docker_image"]
        detected = result.get("detected_health_endpoint")
        if detected and not service.health_check_endpoint:
            service.health_check_endpoint = detected
        service.status = "active"   # 자동 승격
        service.build_log = None
    else:
        service.build_log = result.get("message") or "빌드 실패"
        service.status = "draft"    # 재시도 가능하도록 유지

    await db.commit()
    await db.refresh(service)

    await record_audit(
        db, current_operator, "ops.service.build.finish",
        "service", service.id,
        {"service_id": service_id, "build_status": final_status},
        request.client.host if request.client else None,
    )
    return {
        "service_id": service_id,
        "build_status": final_status,
        "docker_image": service.docker_image,
        "message": result.get("message", ""),
    }


@router.get("/{service_id}/build-log")
async def get_build_log(
    service_id: str,
    current_operator: Operator = Depends(get_current_operator),
):
    """빌드 로그 조회 → deploy-service 프록시."""
    import httpx
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{settings.DEPLOY_SERVICE_URL}/build/{service_id}/log",
            headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
        )
    if resp.status_code != 200:
        raise HTTPException(502, f"빌드 로그 조회 실패: {resp.text}")
    return resp.json()


@router.post("/{service_id}/validate-image")
async def validate_image(
    service_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """이미지 검증 (pull + 테스트 컨테이너 헬스체크)."""
    service = await db.get(VulnService, service_id)
    if not service:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    if not service.docker_image:
        raise HTTPException(400, "docker_image가 설정되지 않았습니다")
    if not service.container_port:
        raise HTTPException(400, "container_port가 설정되지 않았습니다")

    import httpx
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{settings.DEPLOY_SERVICE_URL}/build/validate/{service_id}",
            json={"docker_image": service.docker_image, "container_port": service.container_port,
                  "health_check_endpoint": service.health_check_endpoint},
            headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
        )
    if resp.status_code != 200:
        raise HTTPException(502, f"이미지 검증 실패: {resp.text}")

    await record_audit(
        db, current_operator, "ops.service.validate_image",
        "service", service.id,
        {"service_id": service_id},
        request.client.host if request.client else None,
    )
    return resp.json()


@router.post("/{service_id}/activate", response_model=ServiceResponse)
async def activate_service(
    service_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_operator: Operator = Depends(get_current_operator),
):
    """이미지 모드 서비스를 draft → active로 승격한다.

    Dockerfile 모드는 빌드 콜백이 자동 승격하므로 이 엔드포인트를 호출할 필요가 없다.
    이미지 모드만 해당되며, 내부적으로 deploy-service의 validate_image를 호출하여
    테스트 컨테이너 헬스체크가 성공해야만 active로 전환한다.
    """
    service = await _get_service_or_404(db, service_id)

    if service.env_type == "connection_info":
        if not (service.connection_info or "").strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="접속 정보가 비어 있어 활성화할 수 없습니다.",
            )
        service.status = "active"
        await db.commit()
        await record_audit(
            db, current_operator, "ops.service.activate",
            "service", service.id,
            {"service_id": service_id, "mode": "connection_info"},
            request.client.host if request.client else None,
        )
        await db.refresh(service)

        op_ids = {service.registered_by}
        if service.approved_by:
            op_ids.add(service.approved_by)
        name_map = await _resolve_operator_names(db, op_ids)
        return _to_response(service, name_map)

    if service.env_type != "image":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Dockerfile 모드 서비스는 빌드 성공 시 자동으로 활성화됩니다.",
        )
    if service.status != "draft":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="draft 상태의 서비스만 활성화할 수 있습니다.",
        )
    if not service.docker_image:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="docker_image가 설정되지 않았습니다.",
        )
    if not service.container_port:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="container_port가 설정되지 않았습니다.",
        )

    import httpx
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{settings.DEPLOY_SERVICE_URL}/build/validate/{service_id}",
            json={
                "docker_image": service.docker_image,
                "container_port": service.container_port,
                "health_check_endpoint": service.health_check_endpoint,
            },
            headers={"X-Internal-API-Key": settings.INTERNAL_API_KEY},
        )
    if resp.status_code != 200:
        raise HTTPException(502, f"이미지 검증 실패: {resp.text}")
    validation = resp.json()
    if not validation.get("valid"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"이미지 검증 실패: {validation.get('error') or '알 수 없는 오류'}",
        )

    # Task 3 probing 결과가 있고 수동 입력이 없으면 반영
    detected = validation.get("detected_health_endpoint")
    if detected and not service.health_check_endpoint:
        service.health_check_endpoint = detected

    service.status = "active"
    await db.commit()

    await record_audit(
        db, current_operator, "ops.service.activate",
        "service", service.id,
        {"service_id": service_id, "detected_health_endpoint": detected},
        request.client.host if request.client else None,
    )
    await db.refresh(service)

    op_ids = {service.registered_by}
    if service.approved_by:
        op_ids.add(service.approved_by)
    name_map = await _resolve_operator_names(db, op_ids)
    return _to_response(service, name_map)
