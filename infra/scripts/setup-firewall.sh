#!/bin/bash
# ============================================================
# C-STRIKE 2026 방화벽 규칙 설정 스크립트
# 실행: sudo bash setup-firewall.sh
#
# 핵심 목표:
#   - 참가자 네트워크(10.10.0.0/16)에서 운영 포털/DB/내부 서비스 접근 차단
#   - 스코어보드(:443)는 모든 네트워크에서 허용
#   - 팀 간 공격/방어 트래픽(FORWARD)은 허용
# ============================================================

set -euo pipefail

echo "=== C-STRIKE 2026 방화벽 규칙 설정 ==="

# ──────────────────────────────────────────────────────────────
# 1. 기존 규칙 초기화
# ──────────────────────────────────────────────────────────────
echo "[1/7] 기존 규칙 초기화..."
iptables -F          # 모든 체인의 규칙 삭제
iptables -X          # 사용자 정의 체인 삭제
iptables -t nat -F   # NAT 테이블 규칙 삭제

# ──────────────────────────────────────────────────────────────
# 2. 기본 정책 설정
#    - INPUT: 기본 DROP (명시적으로 허용한 것만 통과)
#    - FORWARD: 기본 DROP (VPN 트래픽 제어)
#    - OUTPUT: 기본 ACCEPT (서버에서 나가는 트래픽은 허용)
# ──────────────────────────────────────────────────────────────
echo "[2/7] 기본 정책 설정..."
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT

# ──────────────────────────────────────────────────────────────
# 3. 기본 허용 규칙
# ──────────────────────────────────────────────────────────────
echo "[3/7] 기본 허용 규칙..."

# 루프백 인터페이스 허용 (localhost 통신에 필수)
iptables -A INPUT -i lo -j ACCEPT

# 이미 수립된 연결/관련 트래픽 허용
# -> 서버가 외부에 요청한 응답, 기존 TCP 세션 유지 등
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# FORWARD 체인도 기존 연결 허용 (VPN 트래픽 응답)
iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT

# ──────────────────────────────────────────────────────────────
# 4. 전체 공개 포트 (인터넷/VPN 모두 접근 가능)
# ──────────────────────────────────────────────────────────────
echo "[4/7] 공개 포트 허용..."

# 스코어보드 HTTPS (모든 네트워크에서 접근 가능)
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# HTTP -> HTTPS 리다이렉트 (Nginx에서 301 처리)
iptables -A INPUT -p tcp --dport 80 -j ACCEPT

# OpenVPN (참가자/운영진 VPN 접속)
iptables -A INPUT -p udp --dport 1194 -j ACCEPT

# SSH (서버 관리용, 키 인증 권장)
# 보안 강화 시 특정 IP만 허용하도록 변경
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# ──────────────────────────────────────────────────────────────
# 5. 참가자 네트워크 (10.10.0.0/16) 차단 규칙
#    -> 참가자가 접근해서는 안 되는 모든 서비스를 명시적으로 차단
# ──────────────────────────────────────────────────────────────
echo "[5/7] 참가자 네트워크 차단..."

# 운영 포털 접근 차단
# -> 참가자가 관리 인터페이스에 접근하면 대회 무결성 훼손
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 8443 -j DROP

# PostgreSQL 직접 접근 차단
# -> DB에 직접 접근하면 점수 조작, 플래그 유출 가능
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 5432 -j DROP

# Redis 직접 접근 차단
# -> 캐시/Pub-Sub 조작으로 채점 방해 가능
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 6379 -j DROP

# FastAPI 직접 접근 차단
# -> Nginx 우회하여 운영 API에 직접 접근 방지
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 2800 -j DROP

# Next.js 직접 접근 차단
# -> 운영 포털 프론트엔드에 직접 접근 방지
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 2900 -j DROP

# Phase 11: deploy-service + MinIO 포트 차단 (내부 전용)
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 8450 -j DROP  # deploy-service
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 9000 -j DROP  # MinIO S3 API
iptables -A INPUT -s 10.10.0.0/16 -p tcp --dport 9001 -j DROP  # MinIO 콘솔

# ──────────────────────────────────────────────────────────────
# 6. 운영 네트워크 허용 규칙
#    -> 운영진만 접근할 수 있는 서비스
# ──────────────────────────────────────────────────────────────
echo "[6/7] 운영 네트워크 허용..."

# 운영 VPN (10.20.0.0/16) -> 운영 포털 허용
iptables -A INPUT -s 10.20.0.0/16 -p tcp --dport 8443 -j ACCEPT

# 물리 LAN (192.168.100.0/24) -> 운영 포털 허용
# -> 서버와 같은 물리 네트워크에서 직접 접속
iptables -A INPUT -s 192.168.100.0/24 -p tcp --dport 8443 -j ACCEPT

# ──────────────────────────────────────────────────────────────
# 7. VPN 트래픽 포워딩 규칙 (FORWARD 체인)
#    -> 팀 간 공격/방어 트래픽 제어
# ──────────────────────────────────────────────────────────────
echo "[7/7] VPN 트래픽 포워딩..."

# 팀 간 SSH 접근 차단 (네트워크 구성도 v0.1 ACL 규칙)
# -> 공격은 웹 서비스(HTTP/HTTPS 등)만 허용, SSH 침투는 금지
# -> 자기 팀 서버 SSH 접근은 VPN zone→Battle field 경로로 별도 허용됨
#    (3존 분리 시 라우터/VPN 레벨에서 처리 — 네트워크 담당자 영역)
iptables -A FORWARD -s 10.10.0.0/16 -d 10.10.0.0/16 -p tcp --dport 22 -j DROP

# 팀 간 서비스 접근 허용 (Attack-Defense 핵심)
# -> 참가자 네트워크 내에서 다른 팀의 웹 서비스에 접근 가능 (SSH 제외)
iptables -A FORWARD -s 10.10.0.0/16 -d 10.10.0.0/16 -j ACCEPT

# 참가자 -> 운영 네트워크 포워딩 차단
# -> 참가자가 운영 네트워크의 어떤 서비스에도 도달 불가
iptables -A FORWARD -s 10.10.0.0/16 -d 10.20.0.0/16 -j DROP

# 운영 네트워크 -> 참가자 네트워크 포워딩 허용
# -> 채점 엔진이 팀 서비스에 접근 (SLA 체크, 플래그 설정)
iptables -A FORWARD -s 10.20.0.0/16 -d 10.10.0.0/16 -j ACCEPT

# ──────────────────────────────────────────────────────────────
# 규칙 저장 (재부팅 후에도 유지)
# ──────────────────────────────────────────────────────────────
echo ""
echo "규칙 저장 중..."
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4

echo ""
echo "=== 방화벽 설정 완료 ==="
echo ""
echo "검증 명령어:"
echo "  iptables -L INPUT -n -v --line-numbers"
echo "  iptables -L FORWARD -n -v --line-numbers"
echo ""
echo "규칙 수: $(iptables -L INPUT -n | tail -n +3 | wc -l)개 (INPUT)"
echo "규칙 수: $(iptables -L FORWARD -n | tail -n +3 | wc -l)개 (FORWARD)"
