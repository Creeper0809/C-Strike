# Pocket Guestbook

An uploadable sample problem for the ops portal.

## What it demonstrates

- `Dockerfile 업로드` 타입으로 등록 가능한 최소 문제 구조
- team/service metadata exposure through HTTP
- mounted flags exposed through `/api/flags`
- a simple request/response workflow for health checks

## Suggested portal settings

- 문제 이름: `Pocket Guestbook`
- 카테고리: `web`
- 환경 타입: `Dockerfile 업로드`
- 컨테이너 포트: `8000`

## Suggested flag slots

- `flag.txt` / 100 points / Easy
- `flag-2.txt` / 150 points / Medium

## Included files

- `Dockerfile`
- `requirements.txt`
- `app.py`
- `templates/index.html`
- `40-cstrike-bootstrap.sh`
- `healthcheck-scenarios.template.json`

## Useful endpoints

- `/` - HTML overview page
- `/healthz` - simple liveness check
- `/api/team-info` - team metadata
- `/api/messages` - guestbook API
- `/api/flags` - currently mounted flags
