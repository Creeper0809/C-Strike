-- Discord Bot 외주 통합용 테이블 (PostgreSQL)
-- Target: cstrike schema (PostgreSQL 16+)
-- Source: 외주 OPS_BOT/db/schema.py의 11개 테이블 MySQL DDL을 PostgreSQL로 변환
--
-- 제외 대상 (운영포털에 이미 존재하거나 매핑 완료):
--   - tickets, audit_logs(→ops_audit_logs), competitions, teams, team_members
--   - teams__id_map, teams__new, tickets__new, team_members__new (외주 내부 마이그레이션 보조)

CREATE SCHEMA IF NOT EXISTS cstrike;

-- ============================================================
-- 1. ticket_settings (운영포털 신규 추가)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.ticket_settings (
  guild_id varchar(64) PRIMARY KEY,
  notifier_user_id varchar(64) NOT NULL,
  notifier_user_name varchar(255) NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- ============================================================
-- 2. ticket_counters (운영포털 신규 추가, 초기 seed row 포함)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.ticket_counters (
  counter_key varchar(32) PRIMARY KEY,
  seq_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

INSERT INTO cstrike.ticket_counters (counter_key, seq_value, updated_at)
VALUES ('ticket', 0, now())
ON CONFLICT (counter_key) DO NOTHING;

-- ============================================================
-- 3. scheduled_announcements (전체 공지 예약)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.scheduled_announcements (
  id bigserial PRIMARY KEY,
  guild_id varchar(64) NOT NULL,
  channel_id varchar(64) NULL,
  channel_name varchar(128) NULL,
  title varchar(255) NOT NULL,
  description text NOT NULL,
  requested_by varchar(255) NULL,
  scheduled_at timestamptz NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'scheduled',
  job_id varchar(128) NULL,
  created_by_id varchar(64) NULL,
  created_by_name varchar(255) NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  sent_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ix_scheduled_announcements_list
  ON cstrike.scheduled_announcements (guild_id, status, scheduled_at, id);

-- ============================================================
-- 4. team_announcements (팀별 공지)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.team_announcements (
  id bigserial PRIMARY KEY,
  guild_id varchar(64) NOT NULL,
  channel_id varchar(64) NULL,
  channel_name varchar(128) NULL,
  team_id varchar(36) NOT NULL,
  discord_role_id varchar(64) NOT NULL,
  title varchar(255) NOT NULL,
  description text NOT NULL,
  scheduled_at timestamptz NULL,
  status varchar(32) NOT NULL DEFAULT 'scheduled',
  sent_at timestamptz NULL,
  error_message text NULL,
  created_by_id varchar(64) NULL,
  created_by_name varchar(255) NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_team_announcements_list
  ON cstrike.team_announcements (guild_id, status, scheduled_at, id);

CREATE INDEX IF NOT EXISTS ix_team_announcements_team
  ON cstrike.team_announcements (guild_id, team_id, id);

-- ============================================================
-- 5. team_hints (팀별 힌트/자료 전송)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.team_hints (
  id bigserial PRIMARY KEY,
  guild_id varchar(64) NOT NULL,
  channel_id varchar(64) NULL,
  channel_name varchar(128) NULL,
  team_id varchar(36) NOT NULL,
  discord_role_id varchar(64) NOT NULL,
  title varchar(255) NOT NULL,
  description text NULL,
  file_url text NULL,
  file_name varchar(255) NULL,
  scheduled_at timestamptz NULL,
  status varchar(32) NOT NULL DEFAULT 'scheduled',
  sent_at timestamptz NULL,
  error_message text NULL,
  created_by_id varchar(64) NULL,
  created_by_name varchar(255) NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_team_hints_list
  ON cstrike.team_hints (guild_id, status, scheduled_at, id);

CREATE INDEX IF NOT EXISTS ix_team_hints_team
  ON cstrike.team_hints (guild_id, team_id, id);

-- ============================================================
-- 6. team_countdown_schedules (팀별 카운트다운 스케줄)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.team_countdown_schedules (
  id bigserial PRIMARY KEY,
  guild_id varchar(64) NOT NULL,
  channel_id varchar(64) NULL,
  channel_name varchar(128) NULL,
  team_id varchar(36) NOT NULL,
  discord_role_id varchar(64) NOT NULL,
  start_at timestamptz NULL,
  end_at timestamptz NULL,
  status varchar(32) NOT NULL DEFAULT 'scheduled',
  started_at timestamptz NULL,
  ended_at timestamptz NULL,
  error_message text NULL,
  created_by_id varchar(64) NULL,
  created_by_name varchar(255) NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_team_countdowns_list
  ON cstrike.team_countdown_schedules (guild_id, status, start_at, end_at, id);

CREATE INDEX IF NOT EXISTS ix_team_countdowns_team
  ON cstrike.team_countdown_schedules (guild_id, team_id, id);

-- ============================================================
-- 7. team_notification_events (팀 알림 이벤트 중복 방지)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.team_notification_events (
  id bigserial PRIMARY KEY,
  event_key varchar(128) NOT NULL,
  guild_id varchar(64) NOT NULL,
  team_id varchar(36) NULL,
  discord_role_id varchar(64) NOT NULL,
  title varchar(255) NOT NULL,
  description text NOT NULL,
  severity varchar(32) NULL,
  status varchar(32) NOT NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_team_notification_event_key
  ON cstrike.team_notification_events (event_key);

CREATE INDEX IF NOT EXISTS ix_team_notification_events_team
  ON cstrike.team_notification_events (guild_id, team_id, created_at);

-- ============================================================
-- 8. relay_events (운영포털 → 봇 릴레이 이벤트 원장)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.relay_events (
  id bigserial PRIMARY KEY,
  event_type varchar(32) NOT NULL,
  channel_id varchar(64) NOT NULL,
  payload_json text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_relay_events_type_time
  ON cstrike.relay_events (event_type, created_at);

-- ============================================================
-- 9. relay_dispatch_history (릴레이 디스패치 이력)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.relay_dispatch_history (
  id bigserial PRIMARY KEY,
  event_key varchar(191) NULL,
  discord_channel_id varchar(64) NOT NULL,
  status varchar(32) NOT NULL,
  error_message text NULL,
  sent_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_relay_dispatch_event
  ON cstrike.relay_dispatch_history (event_key, created_at);

CREATE INDEX IF NOT EXISTS ix_relay_dispatch_status
  ON cstrike.relay_dispatch_history (status, created_at);

-- ============================================================
-- 10. cguard_user_status (C-Guard 상태 미러, Discord 사용자 기준)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.cguard_user_status (
  discord_user_id varchar(64) PRIMARY KEY,
  status varchar(32) NOT NULL,
  reason text NULL,
  source varchar(64) NULL,
  last_event_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_cguard_status
  ON cstrike.cguard_user_status (status, updated_at);

-- ============================================================
-- 11. problem (문제 카탈로그)
-- ============================================================
CREATE TABLE IF NOT EXISTS cstrike.problem (
  problem_no varchar(64) PRIMARY KEY,
  title varchar(255) NOT NULL,
  category varchar(64) NOT NULL,
  score integer NOT NULL DEFAULT 0,
  difficulty varchar(32) NOT NULL DEFAULT 'Easy',
  description text NULL,
  access_url varchar(2048) NULL,
  download_url varchar(2048) NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_problem_list
  ON cstrike.problem (category, score, problem_no);
