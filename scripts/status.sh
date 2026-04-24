#!/bin/bash
# C-STRIKE 운영 포털 — 상태 확인
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infra"

cd "$INFRA_DIR"

echo "========================================="
echo "  C-STRIKE 2026 운영 포털 상태"
echo "========================================="
echo ""

echo "--- 컨테이너 ---"
docker compose ps
echo ""

echo "--- 헬스체크 ---"
echo -n "Nginx:    " && curl -sf http://localhost/nginx-health && echo "" || echo "DOWN"
echo -n "Backend:  " && curl -sf http://localhost/api/health | python3 -m json.tool 2>/dev/null || echo "DOWN"
echo ""

echo "--- 디스크 사용량 ---"
docker system df --format "table {{.Type}}\t{{.Size}}\t{{.Reclaimable}}"
