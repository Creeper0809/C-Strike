"""SQLAlchemy async 엔진/세션 관리 모듈.

운영 포털(ops)과 동일한 PostgreSQL DB를 사용하되,
독립 프로세스이므로 ORM 모델을 임포트하지 않고 SQLAlchemy Core 쿼리를 사용한다.
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .config import settings

logger = logging.getLogger("scoring.database")

# ── async 엔진 ──
# asyncpg는 기본 search_path='"$user", public'이라 cstrike 스키마 테이블을 찾지 못한다.
# ops-backend와 동일하게 cstrike 스키마를 기본 검색 경로로 지정.
engine = create_async_engine(
    settings.DATABASE_URL,
    pool_size=settings.DB_POOL_MIN,
    max_overflow=settings.DB_POOL_MAX - settings.DB_POOL_MIN,
    pool_pre_ping=True,
    echo=False,
    connect_args={
        "server_settings": {"search_path": "cstrike,public"},
    },
)

# ── 세션 팩토리 ──
async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_session() -> AsyncSession:
    """새 async 세션을 반환한다. 호출자가 async with 또는 close()로 정리해야 한다."""
    return async_session_factory()


async def dispose_engine() -> None:
    """엔진 연결 풀을 안전하게 종료한다."""
    logger.info("DB 엔진 연결 풀 종료 중...")
    await engine.dispose()
    logger.info("DB 엔진 연결 풀 종료 완료")


async def check_connection() -> bool:
    """DB 연결 상태를 확인한다. 정상이면 True, 실패 시 False."""
    try:
        async with async_session_factory() as session:
            await session.execute(text_select_1())
        return True
    except Exception as exc:
        logger.error("DB 연결 확인 실패: %s", exc)
        return False


def text_select_1():
    """SELECT 1 텍스트 구문을 반환한다."""
    from sqlalchemy import text

    return text("SELECT 1")
