# -*- coding: utf-8 -*-
"""C-STRIKE 2026 대회 당일 시나리오 — 실제 API를 통해 데모 데이터를 생성한다.

DB 초기화 후 아래 순서로 실제 API를 호출하여 데이터를 쌓는다:
  1. 대회 설정 (15개 항목)
  2. 취약 서비스 등록 (6개: web 3 + pwn 2 + crypto 1)
  3. 서비스 검토 (5개 승인, 1개 반려)
  4. 배포 파이프라인 시작 (5개)
  5. 취약점팩 생성 및 공개 (3개, 1번 공개)
  6. 티켓 접수 및 처리 (2건 + 응답)
  7. 비상 통제 (채점 중단 → 해제)

모든 감사 로그는 API 호출 시 자동으로 누적된다.

사용법:
  python scripts/demo/competition_day.py [--host 192.168.100.129]
  SERVER_IP=10.0.0.5 python scripts/demo/competition_day.py    # 환경변수 사용

제안요청서(docs/C-Strike 일 분배 초안.pdf) 기반 구성:
  - 서비스 분야: 웹(로그인 우회, SQLi, SSRF), 바이너리(스택, 힙), 암호
  - 취약점팩: 2시간 간격 순차 공개
  - 참여 규모: 20팀, 150명, 24시간
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import http.cookiejar

sys.stdout.reconfigure(encoding="utf-8")

# ============================================================
# 설정
# ============================================================

ADMIN_USER = "admin"
ADMIN_PASS = "admin1234"

COMPETITION_SETTINGS = {
    "competition_name": "C-STRIKE 2026 청주대학교 사이버공격방어대회",
    "competition_date": "2026-04-03",
    "competition_start_time": "10:00",
    "competition_duration_hours": 24,
    "scoring_round_interval_seconds": 120,
    "scoring_flag_rotation": True,
    "team_count": 20,
    "max_participants": 150,
    "vulnpack_count": 5,
    "vulnpack_interval_minutes": 120,
    "bonus_zone_enabled": True,
    "bonus_zone_weight_percent": 25,
    "discord_webhook_enabled": True,
    "network_participant_subnet": "10.10.0.0/16",
    "network_ops_subnet": "10.20.0.0/16",
}

SERVICES = [
    {
        "name": "Login Bypass",
        "description": (
            "세션 토큰 검증 로직의 결함을 이용하여 관리자 권한을 획득하는 웹 서비스. "
            "JWT 서명 검증 우회와 권한 상승 취약점이 포함되어 있다."
        ),
        "category": "web",
        "docker_image": "cstrike/vuln-login-bypass:1.0",
        "docker_compose_config": {
            "services": {"login-bypass": {"image": "cstrike/vuln-login-bypass:1.0", "ports": ["8080:8080"]}}
        },
        "exposed_ports": [8080],
        "flag_format": "FLAG{login_%s}",
        "health_check_endpoint": "/health",
    },
    {
        "name": "SQL Master",
        "description": (
            "게시판 검색 기능에 존재하는 SQL Injection 취약점을 통해 데이터베이스의 "
            "관리자 인증정보를 탈취하는 문제. Blind SQLi와 Union SQLi 두 가지 경로가 존재한다."
        ),
        "category": "web",
        "docker_image": "cstrike/vuln-sql-master:1.0",
        "docker_compose_config": {
            "services": {"sql-master": {"image": "cstrike/vuln-sql-master:1.0", "ports": ["8081:8080"]}}
        },
        "exposed_ports": [8081],
        "flag_format": "FLAG{sqli_%s}",
        "health_check_endpoint": "/health",
    },
    {
        "name": "SSRF Gateway",
        "description": (
            "URL 프리뷰 기능에서 발생하는 Server-Side Request Forgery 취약점. "
            "내부 메타데이터 서버 접근을 통해 서비스 인증 토큰을 획득해야 한다."
        ),
        "category": "web",
        "docker_image": "cstrike/vuln-ssrf-gateway:1.0",
        "docker_compose_config": {
            "services": {"ssrf-gateway": {"image": "cstrike/vuln-ssrf-gateway:1.0", "ports": ["8082:8080"]}}
        },
        "exposed_ports": [8082],
        "flag_format": "FLAG{ssrf_%s}",
        "health_check_endpoint": "/health",
    },
    {
        "name": "Stack Smasher",
        "description": (
            "입력 길이 검증이 누락된 네트워크 데몬에서 스택 버퍼 오버플로우를 이용하여 "
            "쉘을 획득하는 바이너리 문제. NX 활성화, ASLR 적용 환경이다."
        ),
        "category": "pwnable",
        "docker_image": "cstrike/vuln-stack-smasher:1.0",
        "docker_compose_config": {
            "services": {"stack-smasher": {"image": "cstrike/vuln-stack-smasher:1.0", "ports": ["9001:9001"]}}
        },
        "exposed_ports": [9001],
        "flag_format": "FLAG{pwn_stack_%s}",
        "health_check_endpoint": "/health",
    },
    {
        "name": "Heap Maze",
        "description": (
            "동적 메모리 할당 및 해제 과정에서 발생하는 Use-After-Free 취약점을 이용한 "
            "바이너리 문제. tcache poisoning을 통해 임의 주소 쓰기가 가능하다."
        ),
        "category": "pwnable",
        "docker_image": "cstrike/vuln-heap-maze:1.0",
        "docker_compose_config": {
            "services": {"heap-maze": {"image": "cstrike/vuln-heap-maze:1.0", "ports": ["9002:9002"]}}
        },
        "exposed_ports": [9002],
        "flag_format": "FLAG{pwn_heap_%s}",
        "health_check_endpoint": "/health",
    },
    {
        "name": "Crypto Vault",
        "description": (
            "자체 구현된 암호화 프로토콜의 패딩 오라클 취약점을 이용하여 암호문을 복호화하는 문제. "
            "CBC 모드의 IV 재사용 취약점도 존재한다."
        ),
        "category": "crypto",
        "docker_image": "cstrike/vuln-crypto-vault:1.0",
        "docker_compose_config": {
            "services": {"crypto-vault": {"image": "cstrike/vuln-crypto-vault:1.0", "ports": ["9003:9003"]}}
        },
        "exposed_ports": [9003],
        "flag_format": "FLAG{crypto_%s}",
        "health_check_endpoint": "/health",
    },
]

# 마지막(Crypto Vault)을 반려, 나머지 승인
REJECT_INDEX = 5
REJECT_REASON = "Docker 이미지 빌드 실패. libcrypto 의존성 충돌로 컨테이너 시작 불가. 이미지 재빌드 후 재등록 요청."

VULNPACKS = [
    {"pack_number": 1, "label": "Pack Alpha \u2014 웹 기초", "svc_indices": [0, 1], "offset": 0},
    {"pack_number": 2, "label": "Pack Bravo \u2014 웹 심화 + 바이너리", "svc_indices": [2, 3], "offset": 120},
    {"pack_number": 3, "label": "Pack Charlie \u2014 바이너리 심화", "svc_indices": [4], "offset": 240},
    {"pack_number": 4, "label": "Pack Delta \u2014 암호 + 네트워크", "svc_indices": [0, 4], "offset": 360},
    {"pack_number": 5, "label": "Pack Echo \u2014 종합 고난이도", "svc_indices": [1, 2, 3], "offset": 480},
]
RELEASE_PACKS = [0]  # 인덱스 0 = Pack 1 공개

TICKETS = [
    {
        "create": {
            "type": "dispute",
            "title": "VPN 접속 간헐적 끊김 현상",
            "description": (
                "대회 시작 후 약 40분부터 VPN 터널이 간헐적으로 끊기는 현상 발생. "
                "팀원 3명 중 2명이 동시에 끊김을 경험했고, 재접속까지 약 2분 소요. "
                "네트워크 환경 점검 요청."
            ),
            "team_id": "team-07",
            "team_name": "CyberPhoenix",
            "priority": "high",
        },
        "respond": {
            "content": (
                "확인했습니다. OpenVPN 서버 로그 분석 결과 해당 시간대에 keepalive "
                "타임아웃이 다수 발생한 것으로 확인됩니다. 서버 측 keepalive 간격을 "
                "10초에서 5초로 조정하고 모니터링 중입니다. "
                "추가 끊김 발생 시 다시 신고 부탁드립니다."
            ),
            "is_internal": False,
        },
    },
    {
        "create": {
            "type": "violation",
            "title": "비인가 포트 스캔 탐지",
            "description": (
                "team-12 소속 IP에서 운영 서버 대역(10.20.0.0/16)으로의 포트 스캔 시도가 탐지됨. "
                "대회 규정 제4조(운영 영역 접근 금지) 위반으로 판단되어 신고."
            ),
            "team_id": "team-12",
            "team_name": "DarkKnights",
            "priority": "critical",
        },
        "respond": {
            "content": (
                "방화벽 로그 확인 결과 10.20.0.0/16 대역으로 SYN 스캔(nmap -sS)이 "
                "확인되었습니다. 해당 팀에 1차 경고 조치하고 반복 시 실격 처리 예정입니다."
            ),
            "is_internal": True,
        },
    },
]

EMERGENCY = {
    "halt": {
        "reason": "채점 라운드 15에서 플래그 검증 오류 다수 발생. 원인 분석을 위해 채점 일시 중단.",
    },
    "resume": {
        "reason": "플래그 검증 로직 hotfix 적용 완료. 정상 복구 확인 후 채점 재개.",
    },
}


# ============================================================
# API 클라이언트
# ============================================================

class ApiClient:
    def __init__(self, base_url: str):
        self.base = base_url
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    def call(self, method: str, path: str, body=None):
        url = f"{self.base}/api{path}"
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            resp = self.opener.open(req, timeout=10)
            raw = resp.read().decode()
            return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            print(f"  !! {method} {path} -> {e.code}: {raw[:150]}")
            return {"error": e.code}

    def login(self, username: str, password: str):
        return self.call("POST", "/auth/login", {"username": username, "password": password})


def ssh_exec(host: str, cmd: str, user: str = "sijogom", password: str = "1105") -> str:
    import paramiko
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=user, password=password, timeout=10)
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode()
    ssh.close()
    return out


# ============================================================
# 시나리오 실행
# ============================================================

def run(host: str):
    base = f"http://{host}"
    client = ApiClient(base)

    # ---- Phase 0: DB 초기화 ----
    print("=" * 60)
    print("Phase 0: DB 초기화")
    print("=" * 60)
    from reset import reset_db
    reset_db(host)

    # ---- 로그인 ----
    r = client.login(ADMIN_USER, ADMIN_PASS)
    print(f"  {r.get('operator',{}).get('display_name','?')} 로그인\n")

    # ---- Phase 1: 대회 설정 ----
    print("=" * 60)
    print("Phase 1: 대회 설정")
    print("=" * 60)
    client.call("PATCH", "/settings/", {"updates": COMPETITION_SETTINGS})
    print(f"  {len(COMPETITION_SETTINGS)}개 항목 저장\n")

    # ---- Phase 2: 서비스 등록 ----
    print("=" * 60)
    print("Phase 2: 취약 서비스 등록")
    print("=" * 60)
    svc_ids = []
    for svc in SERVICES:
        r = client.call("POST", "/services/", svc)
        sid = r.get("id", "?")
        svc_ids.append(sid)
        print(f"  [{svc['category']:8s}] {svc['name']}")
        time.sleep(0.3)
    print(f"  -> {len(svc_ids)}개 등록 (draft)\n")

    # ---- Phase 3: 서비스 검토 ----
    print("=" * 60)
    print("Phase 3: 서비스 검토")
    print("=" * 60)

    # draft -> pending (API에 submit 엔드포인트가 없으므로 DB 직접 전환)
    ids_csv = "','".join(svc_ids)
    ssh_exec(host, (
        f"docker exec cstrike-postgres psql -U ops_svc -d ops_db "
        f"-c \"UPDATE cstrike.vuln_services SET status='pending' WHERE id IN ('{ids_csv}');\""
    ))
    time.sleep(0.5)

    for i, svc in enumerate(SERVICES):
        if i == REJECT_INDEX:
            client.call("POST", f"/services/{svc_ids[i]}/reject", {"reason": REJECT_REASON})
            print(f"  x 반려: {svc['name']}")
        else:
            client.call("POST", f"/services/{svc_ids[i]}/approve")
            print(f"  v 승인: {svc['name']}")
        time.sleep(0.3)
    print()

    # ---- Phase 4: 배포 파이프라인 ----
    print("=" * 60)
    print("Phase 4: 배포 파이프라인")
    print("=" * 60)
    pipeline_ids = []
    for i, svc in enumerate(SERVICES):
        if i == REJECT_INDEX:
            continue
        r = client.call("POST", "/deploy/pipelines", {"service_id": svc_ids[i]})
        pipeline_ids.append(r.get("id", "?"))
        print(f"  배포: {svc['name']}")
        time.sleep(0.3)
    print(f"  -> {len(pipeline_ids)}개 파이프라인\n")

    # ---- Phase 5: 취약점팩 ----
    print("=" * 60)
    print("Phase 5: 취약점팩")
    print("=" * 60)
    pack_ids = []
    for p in VULNPACKS:
        body = {
            "pack_number": p["pack_number"],
            "label": p["label"],
            "service_ids": [svc_ids[i] for i in p["svc_indices"]],
            "scheduled_offset_minutes": p["offset"],
        }
        r = client.call("POST", "/vulnpacks/", body)
        pack_ids.append(r.get("id", "?"))
        print(f"  팩 {p['pack_number']}: {p['label']}")
        time.sleep(0.3)

    for idx in RELEASE_PACKS:
        client.call("POST", f"/vulnpacks/{pack_ids[idx]}/release")
        print(f"  * 팩 {idx+1} 공개")
    print()

    # ---- Phase 6: 티켓 ----
    print("=" * 60)
    print("Phase 6: 티켓")
    print("=" * 60)
    for t in TICKETS:
        r = client.call("POST", "/tickets/", t["create"])
        tid = r.get("id", "?")
        print(f"  {r.get('ticket_number','?')} [{t['create']['type']}] {t['create']['title']}")
        time.sleep(0.3)

        client.call("PATCH", f"/tickets/{tid}", {"status": "in_progress"})
        client.call("POST", f"/tickets/{tid}/respond", t["respond"])
        label = "내부 메모" if t["respond"]["is_internal"] else "응답"
        print(f"    -> in_progress + {label}")
        time.sleep(0.3)
    print()

    # ---- Phase 7: 비상 통제 ----
    print("=" * 60)
    print("Phase 7: 비상 통제")
    print("=" * 60)

    status = client.call("GET", "/emergency/status")
    if status.get("is_halted"):
        client.call("POST", "/emergency/resume", {"reason": "초기화를 위한 기존 조치 해제."})
        time.sleep(0.5)

    client.call("POST", "/emergency/halt-scoring", EMERGENCY["halt"])
    print(f"  ! 채점 중단: {EMERGENCY['halt']['reason'][:40]}...")
    time.sleep(1)

    client.call("POST", "/emergency/resume", EMERGENCY["resume"])
    print(f"  v 해제: {EMERGENCY['resume']['reason'][:40]}...")

    # ---- 검증 ----
    print("\n" + "=" * 60)
    print("검증")
    print("=" * 60)
    r = client.call("GET", "/services/?page=1&limit=1")
    print(f"  서비스: {r.get('total', '?')}개")
    r = client.call("GET", "/vulnpacks/")
    print(f"  취약점팩: {len(r) if isinstance(r, list) else '?'}개")
    r = client.call("GET", "/deploy/pipelines?page=1&limit=1")
    print(f"  파이프라인: {r.get('total', '?')}개")
    r = client.call("GET", "/tickets/?limit=100")
    print(f"  티켓: {len(r.get('items', []))}개")
    r = client.call("GET", "/audit/?page=1&limit=1")
    print(f"  감사 로그: {r.get('total', '?')}건")
    r = client.call("GET", "/settings/")
    print(f"  설정: {len(r) if isinstance(r, list) else '?'}개")

    print("\n완료!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="C-STRIKE 대회 당일 데모 시나리오")
    parser.add_argument("--host", default=os.environ.get("SERVER_IP", "192.168.100.129"))
    args = parser.parse_args()
    run(args.host)
