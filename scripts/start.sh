#!/bin/bash
# C-STRIKE 운영 포털 — 서버 시작
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infra"

echo "========================================="
echo "  C-STRIKE 2026 운영 포털 시작"
echo "========================================="

# .env 확인
if [ ! -f "$SCRIPT_DIR/../.env" ]; then
    echo "[오류] .env 파일이 없습니다. .env.example을 복사하세요:"
    echo "  cp .env.example .env"
    exit 1
fi

# Docker Compose 변수 치환용 .env 동기화
# compose는 실행 디렉토리의 .env만 읽으므로 infra/.env에 루트 .env를 복제.
# 이게 없으면 ${VAR:-default} 치환이 placeholder로 떨어져 토큰/비밀번호가 유효한데도 실패함.
cp "$SCRIPT_DIR/../.env" "$INFRA_DIR/.env"

# Docker Compose 실행
cd "$INFRA_DIR"
docker compose up -d

# 헬스체크 대기
echo "[정보] 서비스 기동 대기 중..."
sleep 5

# DB 마이그레이션 (최초 실행 시)
echo "[정보] DB 마이그레이션 실행..."
docker compose exec -T ops-backend alembic upgrade head 2>/dev/null || echo "[경고] 마이그레이션 실패 또는 이미 최신"

echo ""
echo "========================================="
echo "  서비스 상태"
echo "========================================="
docker compose ps

echo ""
echo "[완료] http://서버IP 에서 접속 가능합니다."
