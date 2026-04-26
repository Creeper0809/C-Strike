#!/bin/sh
set -eu

WEBROOT="/usr/share/nginx/html"
TEAM_NAME="${CSTRIKE_TEAM_NAME:-unknown-team}"
TEAM_CODE="${CSTRIKE_TEAM_CODE:-unknown-code}"
SERVICE_NAME="${CSTRIKE_SERVICE_NAME:-Shared Web Service}"
TEAM_SUBNET="${CSTRIKE_TEAM_SUBNET:-}"
TEAM_GATEWAY_IP="${CSTRIKE_TEAM_GATEWAY_IP:-}"

mkdir -p "${WEBROOT}"
rm -f "${WEBROOT}/index.html"

cat > "${WEBROOT}/README.txt" <<EOF
Shared Web Service

This challenge intentionally exposes nginx directory listing.
Use the files in this directory to verify which team instance you reached.
EOF

cat > "${WEBROOT}/team-info.txt" <<EOF
team_name=${TEAM_NAME}
team_code=${TEAM_CODE}
service_name=${SERVICE_NAME}
team_vpn_subnet=${TEAM_SUBNET}
team_management_ip=${TEAM_GATEWAY_IP}
EOF

cat > "${WEBROOT}/target.txt" <<EOF
You reached team "${TEAM_NAME}" (${TEAM_CODE}).
EOF

if [ -d /flags ]; then
    for flag_file in /flags/*.txt; do
        [ -f "${flag_file}" ] || continue
        ln -sf "${flag_file}" "${WEBROOT}/$(basename "${flag_file}")"
    done
fi

if [ -f /flag.txt ]; then
    ln -sf /flag.txt "${WEBROOT}/flag.txt"
elif [ ! -f "${WEBROOT}/flag.txt" ]; then
    printf '%s\n' 'FLAG{missing-mounted-flag}' > "${WEBROOT}/flag.txt"
fi
