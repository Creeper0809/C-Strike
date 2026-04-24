-- ops_db는 docker-compose에서 POSTGRES_DB로 생성됨
-- cstrike 스키마 생성
CREATE SCHEMA IF NOT EXISTS cstrike;
-- 추가 확장 기능 활성화
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- operators 테이블 (운영포털 관리자/운영자 계정)
-- SQLAlchemy Base.metadata.create_all()가 동일 테이블을 멱등 생성하지만,
-- clean install 시점에 명시적으로 스키마를 고정하여 컬럼 누락 위험을 원천 차단한다.
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.operators (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  username varchar(50) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  display_name varchar(100) NOT NULL,
  role varchar(20) NOT NULL DEFAULT 'operator',
  is_active boolean DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz,
  discord_user_id varchar(32)
);

-- 기존 DB 업그레이드용 idempotent ALTER (기존 컬럼 없으면 추가)
ALTER TABLE cstrike.operators ADD COLUMN IF NOT EXISTS discord_user_id varchar(32);
