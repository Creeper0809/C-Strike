"""flag_manager의 플래그 심기 경로가 올바른지 검증한다."""

from scoring.flag_manager import FLAG_BASE_DIR, build_plant_ssh_command


def test_flag_base_dir_matches_deployer():
    """FLAG_BASE_DIR이 deployer의 마운트 경로와 일치하는지 확인한다."""
    assert FLAG_BASE_DIR == "/opt/cstrike-flags"


def test_plant_command_path():
    """SSH 명령이 올바른 호스트 경로를 사용하는지 검증한다."""
    cmd = build_plant_ssh_command(
        flag_value="FLAG{abcdef1234567890abcdef1234567890}",
        team_code="alpha",
        service_name="vuln-web",
        filename="flag.txt",
    )
    assert "/opt/cstrike-flags/cstrike-alpha-vuln-web/flag.txt" in cmd
    assert "FLAG{abcdef1234567890abcdef1234567890}" in cmd


def test_plant_command_special_chars():
    """하이픈 포함 이름도 올바른 경로를 생성하는지 검증한다."""
    cmd = build_plant_ssh_command(
        flag_value="FLAG{00000000000000000000000000000000}",
        team_code="team-01",
        service_name="my-vuln-svc",
        filename="flag-rce.txt",
    )
    assert "/opt/cstrike-flags/cstrike-team-01-my-vuln-svc/flag-rce.txt" in cmd
