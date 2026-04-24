#!/bin/bash
# C-STRIKE 운영 포털 — 서버 중지
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infra"

echo "[정보] C-STRIKE 운영 포털을 중지합니다..."
cd "$INFRA_DIR"
docker compose --profile mock down
echo "[완료] 서버가 중지되었습니다."
