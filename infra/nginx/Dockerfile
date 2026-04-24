FROM nginx:alpine

# SSL 자가서명 인증서 생성에 필요한 도구
RUN apk add --no-cache bash openssl

# Nginx 메인 설정 (기존 default.conf 제거 후 교체)
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf

# 서버 블록 설정 (스코어보드 + 운영 포털)
COPY conf.d/ /etc/nginx/conf.d/

# 마운트 포인트 디렉토리 사전 생성
RUN mkdir -p /etc/nginx/ssl /var/cache/nginx/scoreboard /var/www/scoreboard

# SSL 자동 생성 — nginx 공식 이미지의 entrypoint 시스템 활용
# 컨테이너 시작 시 /docker-entrypoint.d/05-generate-ssl.sh가 자동 실행되어
# 호스트 볼륨 마운트된 /etc/nginx/ssl에 인증서 생성 (멱등 — 이미 있으면 skip)
COPY ssl/generate-certs.sh /docker-entrypoint.d/05-generate-ssl.sh
RUN chmod +x /docker-entrypoint.d/05-generate-ssl.sh

# 포트 노출
EXPOSE 80 443 8443
