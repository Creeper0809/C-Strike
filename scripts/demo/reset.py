# -*- coding: utf-8 -*-
"""DB 초기화 — admin 계정만 남기고 모든 데모 데이터를 삭제한다.

사용법:
  python scripts/demo/reset.py [--host 192.168.100.129]
  SERVER_IP=10.0.0.5 python scripts/demo/reset.py    # 환경변수 사용
"""
import argparse
import os
import sys
sys.stdout.reconfigure(encoding="utf-8")

import paramiko


def reset_db(host: str, user: str = "sijogom", password: str = "1105"):
    sql = (
        "DELETE FROM cstrike.ops_audit_logs; "
        "DELETE FROM cstrike.ticket_messages; "
        "DELETE FROM cstrike.tickets; "
        "DELETE FROM cstrike.emergency_actions; "
        "DELETE FROM cstrike.deploy_stages; "
        "DELETE FROM cstrike.deploy_pipelines; "
        "DELETE FROM cstrike.vulnpack_schedules; "
        "DELETE FROM cstrike.vuln_services; "
        "DELETE FROM cstrike.competition_config; "
        "DELETE FROM cstrike.operators WHERE username != 'admin';"
    )

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=user, password=password, timeout=10)

    cmd = f'docker exec cstrike-postgres psql -U ops_svc -d ops_db -c "{sql}"'
    stdin, stdout, stderr = ssh.exec_command(cmd)
    stdout.read()
    ssh.close()

    print(f"[reset] {host} DB 초기화 완료 (admin 계정만 보존)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("SERVER_IP", "192.168.100.129"))
    args = parser.parse_args()
    reset_db(args.host)
