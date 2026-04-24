#!/bin/bash
# C-STRIKE 운영 포털 — PostgreSQL 백업
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infra"
BACKUP_DIR="$SCRIPT_DIR/../backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

echo "[정보] PostgreSQL 백업 시작..."
cd "$INFRA_DIR"
docker compose exec -T postgres pg_dump -U ops_svc ops_db > "$BACKUP_DIR/ops_db_$TIMESTAMP.sql"

# 7일 이상 된 백업 삭제
find "$BACKUP_DIR" -name "*.sql" -mtime +7 -delete

echo "[완료] 백업 완료: backups/ops_db_$TIMESTAMP.sql"
ls -lh "$BACKUP_DIR"/*.sql | tail -5
