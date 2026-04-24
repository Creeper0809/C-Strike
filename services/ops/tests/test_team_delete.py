"""팀 삭제 엔드포인트 — 라우팅 스모크 테스트.

conftest.py 의존성 최소화를 위해 라우터 등록만 검증하고
실제 DB 동작(FK CASCADE, 자식 정리)은 라이브 E2E에서 검증한다.
"""


def test_teams_router_has_delete_endpoint():
    """teams 라우터에 DELETE /{team_id} 엔드포인트가 등록되어 있는지."""
    from app.api.teams import router
    paths_with_methods = [(r.path, r.methods) for r in router.routes]
    has_delete = any(
        p == "/{team_id}" and "DELETE" in m
        for p, m in paths_with_methods
    )
    assert has_delete, f"DELETE /{{team_id}} 엔드포인트 누락: {paths_with_methods}"


def test_teams_router_delete_returns_204():
    """DELETE /{team_id} 핸들러의 status_code가 204인지."""
    from app.api.teams import router
    for r in router.routes:
        if r.path == "/{team_id}" and "DELETE" in r.methods:
            assert r.status_code == 204, \
                f"DELETE 응답 코드가 204가 아님: {r.status_code}"
            return
    raise AssertionError("DELETE /{team_id} 라우트 없음")


def test_delete_team_function_exists():
    """delete_team 핸들러 함수가 모듈에 정의되어 있는지."""
    from app.api import teams as teams_module
    assert hasattr(teams_module, "delete_team"), \
        "delete_team 함수가 teams.py에 정의되지 않음"
