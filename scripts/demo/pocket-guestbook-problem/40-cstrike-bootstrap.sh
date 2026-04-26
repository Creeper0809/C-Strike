#!/bin/sh
set -eu

mkdir -p /app/data

cat > /app/data/team-info.json <<EOF
{
  "team_name": "${CSTRIKE_TEAM_NAME:-unknown-team}",
  "team_code": "${CSTRIKE_TEAM_CODE:-unknown-code}",
  "service_name": "${CSTRIKE_SERVICE_NAME:-Pocket Guestbook}",
  "team_subnet": "${CSTRIKE_TEAM_SUBNET:-}",
  "team_gateway_ip": "${CSTRIKE_TEAM_GATEWAY_IP:-}"
}
EOF
