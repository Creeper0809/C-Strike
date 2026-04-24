"""보안 미들웨어 — OWASP Top 10 기본 대응."""
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """보안 헤더를 모든 응답에 추가한다."""

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        # XSS 방지
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        # 클릭재킹 방지
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
        # 정보 노출 방지
        response.headers["X-Powered-By"] = ""
        response.headers["Server"] = ""
        # HSTS (프로덕션용)
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        # 캐시 제어 (API 응답)
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response
