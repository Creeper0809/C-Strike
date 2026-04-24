"""취약점팩 자동 공개 내부 엔드포인트 — 라우팅 스모크 테스트.

conftest.py 의존성 최소화를 위해 앱 import만 확인하고
실제 DB 동작은 Task 7 라이브 E2E에서 검증한다.
"""


def test_internal_router_has_auto_release_endpoint():
    """internal 라우터에 auto-release 엔드포인트가 등록되어 있는지."""
    from app.api.internal import router
    paths = [r.path for r in router.routes]
    assert any("/vulnpacks/" in p and "/auto-release" in p for p in paths), \
        f"auto-release 엔드포인트 누락: {paths}"


def test_internal_router_auto_release_is_post():
    """auto-release 엔드포인트가 POST 메서드인지."""
    from app.api.internal import router
    for r in router.routes:
        if "/vulnpacks/" in r.path and "/auto-release" in r.path:
            assert "POST" in r.methods
            return
    raise AssertionError("auto-release 라우트 없음")
