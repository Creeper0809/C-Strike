"""Alembic 마이그레이션 환경 설정 — async 지원."""

import asyncio
import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

# 프로젝트 루트를 sys.path에 추가하여 app 모듈 import 가능하게 함
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import Base
from app.models import *  # noqa: F401, F403 — 모든 모델 테이블 등록

# alembic.ini 로깅 설정
config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 컨테이너 환경 대응: DATABASE_URL 환경변수가 있으면 alembic.ini의
# sqlalchemy.url을 override한다 (로컬 개발은 ini 값 사용).
_env_db_url = os.environ.get("DATABASE_URL")
if _env_db_url:
    config.set_main_option("sqlalchemy.url", _env_db_url)

# 마이그레이션 대상 메타데이터
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """오프라인 모드 마이그레이션 (SQL 스크립트 생성용)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    """동기 컨텍스트에서 마이그레이션을 실행한다."""
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """비동기 엔진을 생성하고 마이그레이션을 실행한다."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """온라인 모드 마이그레이션 (async 엔진 사용)."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
