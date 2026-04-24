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
    assert "/opt/cstrike-flags/cstrike-alpha-vuln-web/flag.txt:/flag.txt:ro" in cmd
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
    assert "/opt/cstrike-flags/cstrike-bravo-vuln-api/flag.txt:/flag.txt:ro" in cmd
    assert "-e DB_HOST=localhost" in cmd
    assert "-e SECRET=abc" in cmd
