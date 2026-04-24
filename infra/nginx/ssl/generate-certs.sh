#!/bin/bash
# ============================================================
# C-STRIKE 2026 SSL 인증서 생성 스크립트 (단순 자가서명 방식)
#
# 인증서 2쌍 (스코어보드 + 운영 포털) 자가서명 발급. CA 없음.
# nginx 컨테이너의 /docker-entrypoint.d/에 등록되어 컨테이너 시작 시 자동 실행.
# 호스트 볼륨 마운트된 /etc/nginx/ssl에 발급 → 다음 시작부터 멱등 skip.
#
# 다른 IP 서버에 납품할 때:
#   1) .env에서 SERVER_IP=새IP 로 변경
#   2) 호스트의 infra/nginx/ssl/ 디렉토리 비우기 (멱등 우회)
#   3) cd infra && docker compose up -d --build
#   → 새 IP가 SAN에 들어간 인증서가 자동 재발급됨
# ============================================================

set -euo pipefail

CERT_DIR="/etc/nginx/ssl"
SERVER_IP="${SERVER_IP:-192.168.100.129}"

# 멱등 체크 — 인증서 2쌍 모두 존재하면 재생성 생략
# (재시작 시 새 fingerprint 발급되어 운영자가 매번 "고급→진행" 다시 누르는 것 방지)
if [ -f "$CERT_DIR/scoreboard.crt" ] && [ -f "$CERT_DIR/scoreboard.key" ] \
   && [ -f "$CERT_DIR/ops-portal.crt" ] && [ -f "$CERT_DIR/ops-portal.key" ]; then
    echo "[SSL] 인증서 2쌍 모두 존재. 재생성 생략."
    exit 0
fi

echo "=== C-STRIKE 2026 SSL 자가서명 인증서 생성 ==="
echo "서버 IP: ${SERVER_IP}"

mkdir -p "$CERT_DIR"

# ─── 스코어보드 인증서 (자가서명, leaf 확장 명시) ───
# Chrome은 leaf cert에 CA:FALSE + KeyUsage + ExtendedKeyUsage 없으면 거부
# (openssl req -x509 기본은 v3_ca 섹션 사용 → CA:TRUE 박혀버림)
echo "[1/2] 스코어보드 인증서 생성 중..."
openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout "$CERT_DIR/scoreboard.key" \
    -out "$CERT_DIR/scoreboard.crt" \
    -subj "/C=KR/ST=Chungbuk/L=Cheongju/O=CJU/OU=C-STRIKE/CN=scoreboard.cstrike.local" \
    -addext "subjectAltName=IP:${SERVER_IP},DNS:scoreboard.cstrike.local" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth"

# ─── 운영 포털 인증서 (자가서명, leaf 확장 명시) ───
echo "[2/2] 운영 포털 인증서 생성 중..."
openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout "$CERT_DIR/ops-portal.key" \
    -out "$CERT_DIR/ops-portal.crt" \
    -subj "/C=KR/ST=Chungbuk/L=Cheongju/O=CJU/OU=C-STRIKE/CN=ops.cstrike.local" \
    -addext "subjectAltName=IP:${SERVER_IP},DNS:ops.cstrike.local" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth"

# ─── 권한 설정 ───
chmod 600 "$CERT_DIR"/*.key
chmod 644 "$CERT_DIR"/*.crt

echo ""
echo "=== 완료 ==="
echo "발급 파일:"
echo "  $CERT_DIR/scoreboard.crt  (CN=scoreboard.cstrike.local, SAN: IP ${SERVER_IP})"
echo "  $CERT_DIR/scoreboard.key"
echo "  $CERT_DIR/ops-portal.crt  (CN=ops.cstrike.local, SAN: IP ${SERVER_IP})"
echo "  $CERT_DIR/ops-portal.key"
echo ""
echo "유효기간: 365일"
echo "브라우저 첫 접속 시 '안전하지 않음' 경고 → 고급 → 안전하지 않은 사이트로 이동 (1회)"
