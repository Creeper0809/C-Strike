#!/bin/bash
# C-STRIKE 운영 포털 — 로그 조회
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infra"

SERVICE=${1:-"ops-backend"}
LINES=${2:-100}

cd "$INFRA_DIR"
echo "[정보] $SERVICE 최근 $LINES 줄 로그:"
docker compose logs --tail="$LINES" "$SERVICE"
