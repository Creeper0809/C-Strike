"""팀 생성 엔드포인트 — 라우팅 스모크 테스트.

실제 DB 동작(팀명 중복, 최대 팀 수)은 라이브 E2E에서 검증한다.
"""


def test_teams_router_has_post_endpoint():
    """teams 라우터에 POST / 엔드포인트가 등록되어 있는지."""
    from app.api.teams import router
    paths_with_methods = [(r.path, r.methods) for r in router.routes]
    has_post = any(
        p == "/" and "POST" in m
        for p, m in paths_with_methods
    )
    assert has_post, f"POST / 엔드포인트 누락: {paths_with_methods}"


def test_teams_router_post_returns_201():
    """POST / 핸들러의 status_code가 201인지."""
    from app.api.teams import router
    for r in router.routes:
        if r.path == "/" and "POST" in r.methods:
            assert r.status_code == 201, \
                f"POST 응답 코드가 201이 아님: {r.status_code}"
            return
    raise AssertionError("POST / 라우트 없음")


def test_create_team_function_exists():
    """create_team 핸들러 함수가 모듈에 정의되어 있는지."""
    from app.api import teams as teams_module
    assert hasattr(teams_module, "create_team"), \
        "create_team 함수가 teams.py에 정의되지 않음"
