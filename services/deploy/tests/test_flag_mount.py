"""deployer의 docker run 명령에 read-only 플래그 마운트가 포함되는지 검증한다."""

from app.deployer import ServiceInfo, TeamInfo


def test_build_run_command_contains_ro_mount():
    """build_run_command가 :ro 플래그 마운트를 포함하는지 검증한다."""
    from app.deployer import build_run_command

    service = ServiceInfo(
        service_id="svc-1",
        name="vuln-web",
        docker_image="vuln-web:latest",
        container_port=8080,
    )
    team = TeamInfo(
        team_id="team-1",
        team_code="alpha",
        name="Alpha",
        competition_id="comp-1",
    )
    cmd = build_run_command(service, team)
    assert "/opt/cstrike-flags/cstrike-alpha-vuln-web:/flags:ro" in cmd
    assert "/opt/cstrike-flags/cstrike-alpha-vuln-web/flag.txt:/flag.txt:ro" in cmd
    assert "-p 0.0.0.0:8080:8080" in cmd
    assert "--name cstrike-alpha-vuln-web" in cmd


def test_build_run_command_with_env_vars():
    """환경변수가 있을 때도 :ro 마운트가 유지되는지 검증한다."""
    from app.deployer import build_run_command

    service = ServiceInfo(
        service_id="svc-2",
        name="vuln-api",
        docker_image="vuln-api:latest",
        container_port=3000,
        env_vars={"DB_HOST": "localhost", "SECRET": "abc"},
    )
    team = TeamInfo(
        team_id="team-2",
        team_code="bravo",
        name="Bravo",
        competition_id="comp-1",
    )
    cmd = build_run_command(service, team)
    assert "/opt/cstrike-flags/cstrike-bravo-vuln-api:/flags:ro" in cmd
    assert "/opt/cstrike-flags/cstrike-bravo-vuln-api/flag.txt:/flag.txt:ro" in cmd
    assert "-e CSTRIKE_TEAM_CODE=bravo" in cmd
    assert "-e CSTRIKE_TEAM_NAME=Bravo" in cmd
    assert "-e CSTRIKE_SERVICE_NAME=vuln-api" in cmd
    assert "-e DB_HOST=localhost" in cmd
    assert "-e SECRET=abc" in cmd


def test_build_run_command_uses_primary_flag_slot_mount():
    from app.deployer import build_run_command

    service = ServiceInfo(
        service_id="svc-2b",
        name="multi-flag-web",
        docker_image="multi-flag:latest",
        container_port=8080,
        flag_slots=[
            {"slot_key": "auth", "label": "인증 우회", "filename": "flag-auth.txt", "points": 150, "primary": False},
            {"slot_key": "rce", "label": "RCE", "filename": "flag-rce.txt", "points": 300, "primary": True},
        ],
    )
    team = TeamInfo(
        team_id="team-2b",
        team_code="bravo",
        name="Bravo",
        competition_id="comp-1",
    )
    cmd = build_run_command(service, team)
    assert "/opt/cstrike-flags/cstrike-bravo-multi-flag-web:/flags:ro" in cmd
    assert "/opt/cstrike-flags/cstrike-bravo-multi-flag-web/flag-rce.txt:/flag.txt:ro" in cmd


def test_build_run_command_sanitizes_team_code_for_runtime_name():
    """team_code에 공백/특수문자가 있어도 런타임 이름은 안전해야 한다."""
    from app.deployer import build_run_command

    service = ServiceInfo(
        service_id="svc-3",
        name="Shared Web Service",
        docker_image="shared-web:latest",
        container_port=80,
    )
    team = TeamInfo(
        team_id="team-3",
        team_code="A -9VFR",
        name="A team",
        competition_id="comp-1",
    )
    cmd = build_run_command(service, team)
    assert "--name cstrike-a-9vfr-shared-web-service" in cmd
    assert "-p 0.0.0.0:80:80" in cmd
    assert "/opt/cstrike-flags/cstrike-a-9vfr-shared-web-service:/flags:ro" in cmd
    assert "/opt/cstrike-flags/cstrike-a-9vfr-shared-web-service/flag.txt:/flag.txt:ro" in cmd


def test_build_run_command_binds_to_battlefield_ip_when_team_network_known():
    from app.deployer import build_run_command

    service = ServiceInfo(
        service_id="svc-4",
        name="Shared Web Service",
        docker_image="shared-web:latest",
        container_port=80,
    )
    team = TeamInfo(
        team_id="team-4",
        team_code="charlie",
        name="Charlie",
        subnet="10.88.7.0/24",
        gateway_ip="10.2.7.10",
        competition_id="comp-1",
    )
    cmd = build_run_command(service, team)
    assert "-p 10.1.7.10:80:80" in cmd
