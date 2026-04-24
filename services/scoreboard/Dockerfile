FROM python:3.13-slim

WORKDIR /app

# 시스템 패키지 — 자가서명 SSL 인증서 경고를 위한 ca-certificates만 최소 설치
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 의존성 먼저 복사 + 설치 (빌드 캐시 최적화)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 본체 + 정적 자산
COPY config.py ops_client.py state_adapter.py server.py ./
COPY static ./static

EXPOSE 8000

# 단일 워커 — WebSocket 브로드캐스트가 프로세스 내부 상태이므로 워커 1개 유지.
# 수평 확장이 필요할 때는 Redis Pub/Sub 기반 상태 공유로 리팩터 필요.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
