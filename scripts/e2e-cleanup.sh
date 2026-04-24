#!/bin/bash
# ============================================================================
# E2E 테스트 후 DB 정리 스크립트
# 용도: E2E 테스트로 생성된 데이터를 삭제하고 DB를 clean state로 복원
# 대상: docker exec로 cstrike-postgres 컨테이너 직접 접근 (서버 IP 무관)
#       서버에서 직접 실행 또는 docker-compose 실행 환경에서 실행
#
# 주의: operators 테이블은 절대 삭제하지 않음 (admin 계정 유지)
# ============================================================================

set -euo pipefail

# --- 색상 정의 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# --- 설정 ---
POSTGRES_CONTAINER="cstrike-postgres"
DB_USER="ops_svc"
DB_NAME="ops_db"

# --- 유틸 함수 ---
log_info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

run_sql() {
    docker exec "${POSTGRES_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -t -c "$1" 2>/dev/null
}

run_sql_verbose() {
    docker exec "${POSTGRES_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -c "$1" 2>&1
}

# --- 안전장치: 실행 확인 프롬프트 ---
echo ""
echo -e "${RED}============================================================${NC}"
echo -e "${RED}  경고: E2E 테스트 데이터 전체 삭제 스크립트${NC}"
echo -e "${RED}============================================================${NC}"
echo ""
echo "  대상 컨테이너: ${POSTGRES_CONTAINER}"
echo "  대상 DB:       ${DB_NAME}"
echo "  보존 테이블:   operators (admin 계정 유지)"
echo ""
echo -e "${YELLOW}  이 스크립트는 operators를 제외한 모든 테이블의 데이터를 삭제합니다.${NC}"
echo ""
read -r -p "정말 정리하시겠습니까? [y/N] " response
case "${response}" in
    [yY]|[yY][eE][sS])
        log_info "정리를 시작합니다..."
        ;;
    *)
        log_warn "취소되었습니다."
        exit 0
        ;;
esac

# ============================================================================
# 1단계: 테스트로 생성된 Docker 컨테이너 제거 (cstrike 라벨 기반)
# ============================================================================
echo ""
log_info "=== 1단계: 테스트 Docker 컨테이너 제거 ==="

# deploy-service가 생성하는 팀 서비스 컨테이너 정리
# 컨테이너 이름 패턴: cstrike-team-* 또는 라벨 기반
TEST_CONTAINERS=$(docker ps -a --filter "name=cstrike-team-" --format "{{.Names}}" 2>/dev/null || true)

if [ -n "${TEST_CONTAINERS}" ]; then
    log_info "제거 대상 컨테이너:"
    echo "${TEST_CONTAINERS}" | while read -r name; do
        echo "  - ${name}"
    done

    echo "${TEST_CONTAINERS}" | while read -r name; do
        docker rm -f "${name}" >/dev/null 2>&1 && \
            log_ok "컨테이너 제거: ${name}" || \
            log_warn "컨테이너 제거 실패 (이미 없을 수 있음): ${name}"
    done
else
    log_ok "제거할 테스트 컨테이너 없음"
fi

# label 기반 추가 정리 (cstrike.e2e=true 라벨이 있는 컨테이너)
LABELED_CONTAINERS=$(docker ps -a --filter "label=cstrike.e2e=true" --format "{{.Names}}" 2>/dev/null || true)

if [ -n "${LABELED_CONTAINERS}" ]; then
    log_info "E2E 라벨 컨테이너 제거:"
    echo "${LABELED_CONTAINERS}" | while read -r name; do
        docker rm -f "${name}" >/dev/null 2>&1 && \
            log_ok "컨테이너 제거: ${name}" || \
            log_warn "컨테이너 제거 실패: ${name}"
    done
else
    log_ok "E2E 라벨 컨테이너 없음"
fi

# ============================================================================
# 2단계: DB 테이블 데이터 삭제 (FK 의존성 순서: 자식 → 부모)
# ============================================================================
echo ""
log_info "=== 2단계: DB 테이블 데이터 삭제 (FK 순서 준수) ==="

# postgres 컨테이너 동작 여부 확인
if ! docker ps --format "{{.Names}}" | grep -q "^${POSTGRES_CONTAINER}$"; then
    log_error "postgres 컨테이너(${POSTGRES_CONTAINER})가 실행 중이 아닙니다."
    exit 1
fi

# DB 접속 확인
if ! run_sql "SELECT 1;" >/dev/null 2>&1; then
    log_error "DB 접속 실패 (${DB_USER}@${DB_NAME})"
    exit 1
fi
log_ok "DB 접속 확인 완료"

# --------------------------------------------------------------------------
# FK 의존성 트리 (삭제 순서: 가장 깊은 자식부터)
#
#   operators (보존 — 절대 삭제 금지)
#   └── competitions
#       ├── scoring_rounds
#       │   ├── flags
#       │   │   └── flag_submissions  ← 가장 먼저 삭제
#       │   ├── sla_checks
#       │   └── team_scores
#       ├── teams
#       │   ├── team_members
#       │   ├── team_services → sla_checks 참조
#       │   ├── flags, flag_submissions, team_scores 참조
#       │   └── feedbacks
#       ├── vuln_services
#       │   ├── team_services
#       │   ├── flags, sla_checks 참조
#       │   ├── deploy_pipelines
#       │   │   └── deploy_stages
#       │   └── emergency_actions
#       ├── vulnpack_schedules
#       ├── competition_config
#       ├── tickets
#       │   └── ticket_messages
#       └── feedbacks
#
# --------------------------------------------------------------------------

# 삭제 순서 배열 (자식 → 부모)
TABLES_TO_DELETE=(
    # --- Layer 4: 가장 깊은 자식 테이블 ---
    "flag_submissions"       # FK: flags, scoring_rounds, teams, vuln_services, competitions
    "deploy_stages"          # FK: deploy_pipelines
    "ticket_messages"        # FK: tickets, operators

    # --- Layer 3: 중간 자식 테이블 ---
    "flags"                  # FK: scoring_rounds, teams, vuln_services
    "sla_checks"             # FK: scoring_rounds, teams, vuln_services, team_services
    "team_scores"            # FK: scoring_rounds, teams
    "ops_audit_logs"         # FK: operators (operators 데이터는 보존하되 로그는 삭제)

    # --- Layer 2: 부모 참조가 있는 테이블 ---
    "team_services"          # FK: teams, vuln_services
    "team_members"           # FK: teams
    "deploy_pipelines"       # FK: vuln_services, operators, self-ref(rollback_of)
    "emergency_actions"      # FK: vuln_services, operators
    "feedbacks"              # FK: competitions, teams

    # --- Layer 1: 상위 엔티티 ---
    "tickets"                # FK: operators
    "vulnpack_schedules"     # FK: operators, competitions
    "teams"                  # FK: competitions
    "vuln_services"          # FK: operators, competitions
    "competition_config"     # FK: operators, competitions
    "scoring_rounds"         # FK: competitions

    # --- Layer 0: 최상위 (operators 제외) ---
    "competitions"           # FK: operators (operators는 보존)
)

TOTAL=${#TABLES_TO_DELETE[@]}
CURRENT=0
FAILED=0

for table in "${TABLES_TO_DELETE[@]}"; do
    CURRENT=$((CURRENT + 1))
    printf "[%2d/%2d] %-25s ... " "${CURRENT}" "${TOTAL}" "${table}"

    result=$(run_sql "DELETE FROM ${table}; SELECT COUNT(*) FROM ${table};" 2>&1)
    if [ $? -eq 0 ]; then
        remaining=$(echo "${result}" | tr -d '[:space:]')
        if [ "${remaining}" = "0" ]; then
            echo -e "${GREEN}완료${NC} (남은 행: 0)"
        else
            echo -e "${YELLOW}주의${NC} (남은 행: ${remaining})"
        fi
    else
        echo -e "${RED}실패${NC}"
        log_error "  → ${result}"
        FAILED=$((FAILED + 1))
    fi
done

# ============================================================================
# 3단계: 삭제 결과 확인 (주요 테이블 row count 출력)
# ============================================================================
echo ""
log_info "=== 3단계: 삭제 결과 확인 ==="
echo ""
printf "%-25s %s\n" "테이블" "행 수"
printf "%-25s %s\n" "-------------------------" "------"

# 전체 테이블 목록 (operators 포함)
ALL_TABLES=(
    "operators"
    "competitions"
    "scoring_rounds"
    "competition_config"
    "teams"
    "team_members"
    "vuln_services"
    "vulnpack_schedules"
    "team_services"
    "deploy_pipelines"
    "deploy_stages"
    "flags"
    "flag_submissions"
    "sla_checks"
    "team_scores"
    "ops_audit_logs"
    "emergency_actions"
    "tickets"
    "ticket_messages"
    "feedbacks"
)

for table in "${ALL_TABLES[@]}"; do
    count=$(run_sql "SELECT COUNT(*) FROM ${table};" 2>/dev/null | tr -d '[:space:]')
    if [ -z "${count}" ]; then
        count="ERR"
    fi

    if [ "${table}" = "operators" ]; then
        # operators는 보존 대상이므로 별도 표시
        printf "%-25s %s ${CYAN}(보존됨)${NC}\n" "${table}" "${count}"
    elif [ "${count}" != "0" ] && [ "${count}" != "ERR" ]; then
        printf "%-25s ${YELLOW}%s${NC}\n" "${table}" "${count}"
    else
        printf "%-25s %s\n" "${table}" "${count}"
    fi
done

# ============================================================================
# Redis 캐시 플러시 (선택)
# ============================================================================
echo ""
log_info "=== Redis 캐시 정리 ==="
REDIS_CONTAINER="cstrike-redis"

if docker ps --format "{{.Names}}" | grep -q "^${REDIS_CONTAINER}$"; then
    REDIS_PASSWORD="${REDIS_PASSWORD:-redis_password}"
    docker exec "${REDIS_CONTAINER}" redis-cli -a "${REDIS_PASSWORD}" FLUSHALL --no-auth-warning >/dev/null 2>&1 && \
        log_ok "Redis 전체 캐시 플러시 완료" || \
        log_warn "Redis 플러시 실패"
else
    log_warn "Redis 컨테이너(${REDIS_CONTAINER})가 실행 중이 아닙니다. 건너뜀."
fi

# ============================================================================
# 최종 요약
# ============================================================================
echo ""
echo -e "${GREEN}============================================================${NC}"
if [ "${FAILED}" -eq 0 ]; then
    echo -e "${GREEN}  E2E 테스트 정리 완료 (오류 없음)${NC}"
else
    echo -e "${YELLOW}  E2E 테스트 정리 완료 (${FAILED}건 오류 발생)${NC}"
fi
echo -e "${GREEN}============================================================${NC}"
echo ""
