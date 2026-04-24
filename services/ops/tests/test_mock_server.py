"""Mock 서버 엔드포인트 통합 테스트."""
import pytest


@pytest.mark.anyio
async def test_root_health(mock_client):
    resp = await mock_client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"


@pytest.mark.anyio
async def test_vanguard_zones(mock_client):
    resp = await mock_client.get("/api/vanguard/zones")
    assert resp.status_code == 200
    zones = resp.json()
    assert len(zones) == 2
    assert zones[0]["type"] == "participant"


@pytest.mark.anyio
async def test_vanguard_zone_detail(mock_client):
    resp = await mock_client.get("/api/vanguard/zones/zone-1/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["zone_id"] == "zone-1"


@pytest.mark.anyio
async def test_scoring_status(mock_client):
    resp = await mock_client.get("/api/scoring/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_running"] is True
    assert data["current_round"] == 15


@pytest.mark.anyio
async def test_scoring_rounds(mock_client):
    resp = await mock_client.get("/api/scoring/rounds")
    assert resp.status_code == 200
    rounds = resp.json()
    assert len(rounds) > 0


@pytest.mark.anyio
async def test_scoring_pause_resume(mock_client):
    # 중단
    resp = await mock_client.post("/api/scoring/pause", json={"reason": "테스트"})
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    # 상태 확인 — is_running이 false
    resp = await mock_client.get("/api/scoring/status")
    assert resp.json()["is_running"] is False

    # 재개
    resp = await mock_client.post("/api/scoring/resume", json={"reason": "테스트 완료"})
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_containers_teams(mock_client):
    resp = await mock_client.get("/api/containers/teams")
    assert resp.status_code == 200
    teams = resp.json()
    assert len(teams) == 10


@pytest.mark.anyio
async def test_containers_team_detail(mock_client):
    resp = await mock_client.get("/api/containers/teams/team-1")
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_scoreboard_teams(mock_client):
    resp = await mock_client.get("/api/scoreboard/teams")
    assert resp.status_code == 200
    teams = resp.json()
    assert len(teams) == 10
    assert teams[0]["rank"] == 1


@pytest.mark.anyio
async def test_scoreboard_freeze_unfreeze(mock_client):
    resp = await mock_client.post("/api/scoreboard/freeze", json={"reason": "테스트"})
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    resp = await mock_client.post("/api/scoreboard/unfreeze")
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_discord_tickets(mock_client):
    resp = await mock_client.get("/api/discord/tickets")
    assert resp.status_code == 200
    tickets = resp.json()
    assert len(tickets) >= 3


@pytest.mark.anyio
async def test_discord_announce(mock_client):
    resp = await mock_client.post("/api/discord/announce", json={
        "title": "테스트 공지",
        "content": "테스트 내용",
        "channel_type": "general"
    })
    assert resp.status_code == 200
    assert resp.json()["success"] is True


@pytest.mark.anyio
async def test_scenario_switching(mock_client):
    # emergency 시나리오
    resp = await mock_client.get("/api/vanguard/zones?scenario=emergency")
    zones = resp.json()
    assert zones[0]["status"] == "down"  # zone-1은 emergency에서 down

    # normal 시나리오
    resp = await mock_client.get("/api/vanguard/zones?scenario=normal")
    zones = resp.json()
    assert zones[0]["status"] == "up"


@pytest.mark.anyio
async def test_all_health_endpoints(mock_client):
    for system in ["vanguard", "scoring", "containers", "scoreboard", "discord"]:
        resp = await mock_client.get(f"/api/{system}/health")
        assert resp.status_code == 200
        assert "status" in resp.json()
