#!/bin/bash
# ============================================================================
# C-STRIKE E2E API 테스트 스크립트
# 봇 API (X-Bot-API-Key 인증) + 스코어보드 공개 API (인증 없음) 검증
#
# 사용법:
#   bash e2e-api-test.sh [BASE_URL] [BOT_API_KEY] [COMPETITION_ID]
#
# 환경변수 (BASE_URL 미지정 시 사용):
#   SERVER_IP   대상 서버 IP (default: 192.168.100.129)
#
# 예시:
#   SERVER_IP=10.0.0.5 bash e2e-api-test.sh "" my-secret-key "550e8400-..."
#   bash e2e-api-test.sh https://192.168.100.129:8443 my-secret-key "550e8400-..."
# ============================================================================

set -euo pipefail

# ── 인자 및 기본값 ──────────────────────────────────────────

SERVER_IP="${SERVER_IP:-192.168.100.129}"
BASE_URL="${1:-https://${SERVER_IP}:8443}"
BOT_API_KEY="${2:-}"
COMPETITION_ID="${3:-}"

if [[ -z "$BOT_API_KEY" ]]; then
    echo "[오류] BOT_API_KEY가 필요합니다."
    echo "사용법: bash $0 [BASE_URL] [BOT_API_KEY] [COMPETITION_ID]"
    exit 1
fi

if [[ -z "$COMPETITION_ID" ]]; then
    echo "[오류] COMPETITION_ID가 필요합니다."
    echo "사용법: bash $0 [BASE_URL] [BOT_API_KEY] [COMPETITION_ID]"
    exit 1
fi

# ── jq 존재 여부 확인 ────────────────────────────────────────

HAS_JQ=false
if command -v jq &>/dev/null; then
    HAS_JQ=true
fi

# ── 카운터 ───────────────────────────────────────────────────

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0

# ── 유틸 함수 ────────────────────────────────────────────────

# 응답 body를 정리하여 출력 (jq가 있으면 pretty-print)
pretty_print() {
    local body="$1"
    if [[ "$HAS_JQ" == true ]]; then
        echo "$body" | jq . 2>/dev/null || echo "$body"
    else
        echo "$body"
    fi
}

# HTTP 호출 후 상태코드 + 바디 출력, 성공/실패 판정
# $1 = 테스트 이름
# $2 = HTTP 메서드 (GET, POST, DELETE)
# $3 = URL
# $4 = 추가 curl 옵션들 (헤더, 바디 등)
run_test() {
    local test_name="$1"
    shift
    local method="$1"
    shift
    local url="$1"
    shift
    # 나머지는 추가 curl 옵션

    TOTAL_COUNT=$((TOTAL_COUNT + 1))

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[$TOTAL_COUNT] $test_name"
    echo "  $method $url"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # curl 실행: -sk (자체서명 인증서 허용), -w (상태코드 추출)
    local response
    local http_code
    response=$(curl -sk -w "\n%{http_code}" -X "$method" "$url" "$@" 2>/dev/null) || true

    # 마지막 줄 = HTTP 상태코드, 나머지 = body
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | sed '$d')

    echo "  HTTP 상태코드: $http_code"
    echo "  응답 본문:"
    pretty_print "$body" | sed 's/^/    /'

    # 2xx이면 성공, 그 외 실패
    if [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
        echo "  ✅ 성공 (${http_code})"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "  ❌ 실패 (${http_code})"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# ============================================================================
# 테스트 시작
# ============================================================================

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║           C-STRIKE E2E API 테스트 시작                   ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  BASE_URL       : $BASE_URL"
echo "║  COMPETITION_ID : $COMPETITION_ID"
echo "║  jq 사용 가능   : $HAS_JQ"
echo "╚════════════════════════════════════════════════════════════╝"

# ── 1) 로그인 (JWT 토큰 획득) ─────────────────────────────────

echo ""
echo "========================================"
echo " [섹션 1] 로그인 API (JWT 토큰 획득)"
echo "========================================"

# 로그인 비밀번호 입력 (표준 입력으로)
echo ""
read -r -s -p "관리자 비밀번호를 입력하세요: " ADMIN_PASSWORD
echo ""

run_test "POST /api/auth/login — 로그인" \
    POST "${BASE_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASSWORD}\"}"

# ── 2) 봇 API (X-Bot-API-Key 헤더) ───────────────────────────

echo ""
echo ""
echo "========================================"
echo " [섹션 2] 봇 API (X-Bot-API-Key 인증)"
echo "========================================"

# 2-1) 팀 생성
run_test "POST /api/v1/bot/teams — 팀 생성" \
    POST "${BASE_URL}/api/v1/bot/teams" \
    -H "Content-Type: application/json" \
    -H "X-Bot-API-Key: ${BOT_API_KEY}" \
    -d "{\"competition_id\":\"${COMPETITION_ID}\",\"name\":\"E2E-TestTeam\",\"captain_discord_id\":\"test_captain_001\",\"captain_discord_username\":\"E2E테스터\"}"

# 2-2) 팀 목록 조회
run_test "GET /api/v1/bot/teams — 팀 목록 조회" \
    GET "${BASE_URL}/api/v1/bot/teams?competition_id=${COMPETITION_ID}" \
    -H "X-Bot-API-Key: ${BOT_API_KEY}"

# 2-3) 내 팀 조회
run_test "GET /api/v1/bot/teams/my — 내 소속 팀 조회" \
    GET "${BASE_URL}/api/v1/bot/teams/my?discord_user_id=test_captain_001&competition_id=${COMPETITION_ID}" \
    -H "X-Bot-API-Key: ${BOT_API_KEY}"

# 2-4) 플래그 제출
run_test "POST /api/v1/bot/flags/submit — 플래그 제출" \
    POST "${BASE_URL}/api/v1/bot/flags/submit" \
    -H "Content-Type: application/json" \
    -H "X-Bot-API-Key: ${BOT_API_KEY}" \
    -d "{\"competition_id\":\"${COMPETITION_ID}\",\"discord_user_id\":\"test_captain_001\",\"submitted_flag\":\"FLAG{e2e_test_flag}\"}"

# 2-5) 점수 조회
run_test "GET /api/v1/bot/scores — 점수 조회" \
    GET "${BASE_URL}/api/v1/bot/scores?competition_id=${COMPETITION_ID}" \
    -H "X-Bot-API-Key: ${BOT_API_KEY}"

# 2-6) 서비스 상태 조회
run_test "GET /api/v1/bot/status/{discord_id} — 서비스 상태 조회" \
    GET "${BASE_URL}/api/v1/bot/status/test_captain_001?competition_id=${COMPETITION_ID}" \
    -H "X-Bot-API-Key: ${BOT_API_KEY}"

# ── 3) 스코어보드 공개 API (인증 없음) ────────────────────────

echo ""
echo ""
echo "========================================"
echo " [섹션 3] 스코어보드 공개 API (인증 없음)"
echo "========================================"

# 3-1) 대회 정보
run_test "GET /api/v1/scoreboard/{id}/info — 대회 정보" \
    GET "${BASE_URL}/api/v1/scoreboard/${COMPETITION_ID}/info"

# 3-2) 랭킹
run_test "GET /api/v1/scoreboard/{id}/rankings — 실시간 순위" \
    GET "${BASE_URL}/api/v1/scoreboard/${COMPETITION_ID}/rankings"

# 3-3) 차트 데이터
run_test "GET /api/v1/scoreboard/{id}/chart — 차트 데이터" \
    GET "${BASE_URL}/api/v1/scoreboard/${COMPETITION_ID}/chart"

# 3-4) 서비스 매트릭스
run_test "GET /api/v1/scoreboard/{id}/matrix — 서비스 매트릭스" \
    GET "${BASE_URL}/api/v1/scoreboard/${COMPETITION_ID}/matrix"

# 3-5) 이벤트 로그
run_test "GET /api/v1/scoreboard/{id}/events — 이벤트 로그" \
    GET "${BASE_URL}/api/v1/scoreboard/${COMPETITION_ID}/events"

# ============================================================================
# 결과 요약
# ============================================================================

echo ""
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                    테스트 결과 요약                       ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  전체  : ${TOTAL_COUNT}건"
echo "║  성공  : ${PASS_COUNT}건"
echo "║  실패  : ${FAIL_COUNT}건"
echo "╚════════════════════════════════════════════════════════════╝"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo ""
    echo "⚠️  실패한 테스트가 ${FAIL_COUNT}건 있습니다. 위 로그를 확인하세요."
    exit 1
else
    echo ""
    echo "🎉 모든 테스트를 통과했습니다!"
    exit 0
fi
