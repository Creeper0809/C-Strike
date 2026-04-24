"""채점 엔진 진입점.

실행 방법:
    python -m scoring

독립 asyncio 프로세스로 실행되며, 대회 status=running 상태가 될 때까지 대기한 후
라운드 주기 채점을 시작한다. SIGTERM/SIGINT로 graceful shutdown 가능.
"""

import asyncio
import logging
import sys

from .config import settings
from .health import HealthServer
from .round_runner import RoundRunner


def setup_logging() -> None:
    """로깅을 설정한다."""
    log_level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    # 채점 엔진 루트 로거
    root_logger = logging.getLogger("scoring")
    root_logger.setLevel(log_level)
    root_logger.addHandler(handler)

    # SQLAlchemy 엔진 로그는 WARNING 이상만
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)


async def main() -> None:
    """채점 엔진 메인 함수."""
    setup_logging()
    logger = logging.getLogger("scoring.__main__")

    logger.info("=" * 60)
    logger.info("C-STRIKE 채점 엔진 v0.1.0 시작")
    logger.info("DB: %s", settings.DATABASE_URL.split("@")[-1])  # 비밀번호 마스킹
    logger.info("Redis: %s", settings.REDIS_URL)
    logger.info("라운드 간격 오버라이드: %s", settings.ROUND_INTERVAL_OVERRIDE or "DB 설정 사용")
    logger.info("로그 레벨: %s", settings.LOG_LEVEL)
    logger.info("=" * 60)

    runner = RoundRunner()

    # 헬스체크 서버 백그라운드 시작
    health_server = HealthServer(runner)
    health_task = asyncio.create_task(health_server.start())

    try:
        await runner.run()
    finally:
        await health_server.stop()
        health_task.cancel()
        try:
            await health_task
        except asyncio.CancelledError:
            pass

    logger.info("채점 엔진 정상 종료")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
