# C-STRIKE 2026 운영 포털

국내 대학생 대상 **CTF(Capture the Flag) 대회 운영을 위한 통합 관제 플랫폼**입니다.
운영자가 대회 전반(팀 · 문제 · 채점 · 네트워크 · Discord)을 실시간으로 관제하고, 참가자는 분리된 스코어보드로 순위를 확인하는 구조입니다.

---

## 주요 기능

- **운영 포털** — 팀 · 참가자 · 문제 · 취약점 팩 · 네트워크 · 대회 일정 통합 관리
- **실시간 채점 엔진** — SSH 기반 플래그 검증, 10초 SLA, 라운드 단위 점수 집계
- **참가자 스코어보드** — WebSocket 실시간 순위 · 풀이 그래프
- **Discord 봇 연동** — 팀 역할 자동 동기화, 감사 로그, 티켓 시스템
- **C-가드 연동** — 외부 무결성/위험 점수 기반 참가 제한 (외주 시스템)
- **취약점 팩 배포** — MinIO 저장소 + deploy-service로 팀 서버 자동 배포
- **자가서명 SSL 자동화** — 서버 IP 기반 인증서 자동 발급 (폐쇄망 대회 대비)

---

## 시스템 구성

| 서비스 | 외부 포트 | 설명 |
|--------|-----------|------|
| nginx (ops-portal) | **8443** | 운영 포털 HTTPS 게이트웨이 |
| nginx (scoreboard) | **443** | 참가자 스코어보드 HTTPS 게이트웨이 |
| ops-backend (FastAPI) | internal | 운영 API |
| ops-frontend (Next.js) | internal | 운영 대시보드 |
| scoreboard (Next.js) | internal | 참가자 스코어보드 |
| scoring-engine | 8460 | 플래그 검증 엔진 |
| deploy-service | internal | 취약점 팩 배포 서비스 |
| postgres | 5432 | 운영 DB (schema: `cstrike`) |
| redis | 6379 | 캐시 · 세션 · 네트워크 격리 상태 |
| minio | 9000 | 취약점 팩 S3 호환 저장소 |
| discord-bot | 5000 | Discord 통합 봇 |
| cguard-server / cguard-dashboard | 8500 / 8501 | 외주 C-가드 시스템 |

---

## 사전 요구사항

- Docker **24+** / Docker Compose **v2+**
- Linux 호스트 (Ubuntu 22.04+ 권장)
- 최소 RAM 4GB, 디스크 20GB

---

## 빠른 시작

### 1. 클론 및 환경 설정

```bash
git clone <this-repo-url> C-Strike
cd C-Strike
cp .env.example .env
```

### 2. `.env` 값 채우기

**반드시 교체해야 하는 값**

| 키 | 설명 |
|----|------|
| `SERVER_IP` | 서버 실제 IP (SSL 인증서 SAN에 사용) |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | DB · 캐시 비밀번호 |
| `JWT_SECRET_KEY` | 32자 이상 랜덤 문자열 |
| `ADMIN_PASSWORD` | 초기 관리자 계정 비밀번호 |
| `INTERNAL_API_KEY` | 내부 API 공유 키 |
| `MINIO_SECRET_KEY` | MinIO 시크릿 |
| `SSH_ENCRYPTION_KEY`, `SCORING_SSH_ENCRYPTION_KEY` | 동일한 Fernet 키 (아래 참고) |

Fernet 키 생성:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

**Discord 봇을 사용하는 경우** — Discord Developer Portal 에서 봇을 생성한 뒤 다음 값을 교체하세요.

- `DISCORD_TOKEN` · `DISCORD_GUILD_ID`
- `DISCORD_AUDIT_LOG_CHANNEL_ID` · `DISCORD_TICKET_CATEGORY_ID`
- `BOT_API_KEY` (`openssl rand -base64 48` 로 생성)

### 3. 기동

```bash
cd infra
docker compose up -d --build
```

최초 기동은 **약 1~2분** 소요됩니다 (이미지 빌드 + DB 마이그레이션 + 초기 시드).

### 4. 접속

| URL | 용도 | 계정 |
|-----|------|------|
| `https://<SERVER_IP>:8443` | 운영 포털 | `admin` / `.env`의 `ADMIN_PASSWORD` |
| `https://<SERVER_IP>`       | 참가자 스코어보드 | 팀별 발급 계정 |

자가서명 인증서이므로 브라우저에서 **"고급 → 안전하지 않은 사이트로 이동"** 을 1회 클릭해야 합니다.

---

## 프로젝트 구조

```
C-Strike/
├── infra/                   # docker-compose, nginx, Postgres 초기 SQL
│   ├── docker-compose.yml
│   ├── nginx/
│   │   ├── ops-portal.conf
│   │   └── scoreboard.conf
│   └── postgres/init/
├── services/
│   ├── ops/                 # 운영 백엔드 (FastAPI + SQLAlchemy)
│   ├── scoring/             # 채점 엔진
│   ├── scoreboard/          # 참가자 스코어보드
│   ├── discord_bot/         # Discord 통합 봇
│   ├── deploy_service/      # 취약점 팩 배포 서비스
│   └── cguard/              # C-가드 (외주 시스템)
├── frontend/
│   └── ops/                 # 운영 대시보드 (Next.js)
├── scripts/                 # 운영 · 데모 · 정리 스크립트
├── .env.example             # 환경변수 템플릿
└── .gitignore
```

---

## SSL 인증서 운영

기본은 **자가서명**입니다. 공용 IP를 보유한 환경이라면 Let's Encrypt 또는 ZeroSSL 로 무경고 모드 전환이 가능합니다 (상세 절차는 `.env.example` 상단의 SSL 섹션 주석 참고).

### 서버 IP 변경 시 인증서 재발급

```bash
# 1) .env의 SERVER_IP를 새 IP로 교체
# 2) 기존 인증서 제거
rm -f infra/nginx/ssl/{ops-portal,scoreboard}.{crt,key}
# 3) 재기동 — generate-certs.sh 가 새 IP로 재발급
cd infra && docker compose up -d --build
```

---

## 보안 주의사항

- **`.env` 파일은 절대 저장소에 커밋하지 마세요.** `.gitignore` 에서 기본 차단됩니다.
- docker-compose 및 `config.py` 의 기본값(예: `ops_password`, `admin1234`)은 **개발 편의용 fallback** 입니다. 운영 배포 전 반드시 `.env` 에서 강한 값으로 override 하세요.
- **C-가드 외주 코드**(`services/cguard/`) 에는 시드 관리자 계정 (`admin-viewer` / `admin-reviewer` / `admin-enforcer`) 이 포함돼 있습니다. 운영 전 DB 에서 반드시 교체하세요.
- 본 프로젝트는 **폐쇄망 대회 환경**을 전제로 설계됐습니다. 공용 인터넷에 직접 노출할 경우 WAF · 방화벽 등 추가 보호 계층이 필요합니다.

---

## 라이선스

본 저장소는 **내부 사용 및 대회 운영 목적**을 전제로 합니다. 외부 공개 또는 상업적 사용 전 저작권자에게 문의하세요.

C-가드(`services/cguard/`) 는 외주로 제공된 별도 시스템이며 본 저장소의 라이선스와 별개입니다.

---

**C-STRIKE 2026**
