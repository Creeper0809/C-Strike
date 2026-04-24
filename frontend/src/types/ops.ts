export interface Operator {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "operator";
  is_active: boolean;
  discord_user_id: string | null;
  last_login_at: string | null;
  created_at: string | null;
}

export interface OperatorCreatePayload {
  discord_user_id: string;
  display_name: string;
  role: "admin" | "operator";
  username?: string;
  password?: string;
}

export interface OperatorCreateResponse extends Operator {
  generated_password?: string | null;
}

export interface OperatorUpdatePayload {
  display_name?: string;
  role?: "admin" | "operator";
  is_active?: boolean;
  discord_user_id?: string | null;
  password?: string;
}

export interface VulnService {
  id: string;
  name: string;
  description: string | null;
  category: string;
  competition_id: string | null;          // 귀속 대회(ondelete=SET NULL). 배포/롤백 전 필수
  competition_name: string | null;        // 상세 표시용 (백엔드가 프리뷰 문자열로 제공 가능)
  docker_image: string | null;
  health_check_endpoint: string | null;  // Task 6: 헬스체크 경로 (null이면 TCP 체크)
  flag_format: string | null;             // Task 6: 편집 모달용 (FLAG{...})
  // 빌드 성공 시 "active"로 자동 전환. admin 1인 운영 환경이라 pending/approved/rejected는 제거됨.
  status: "draft" | "active";
  version: number;
  registered_by: string;
  registered_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string;
  // Phase 11: 배포 시스템
  env_type: "dockerfile" | "image";
  container_port: number | null;
  build_status: "building" | "success" | "failed" | null;
  build_log: string | null;
  build_started_at: string | null;
  build_completed_at: string | null;
  score: number;
  difficulty: string;
}

export interface BuildFile {
  filename: string;
  size: number;
  last_modified: string | null;
}

export interface BuildFilesResponse {
  service_id: string;
  files: BuildFile[];
}

export interface BuildUploadResponse {
  uploaded: string[];
  errors: Array<{ filename: string; error: string }>;
  detected_port: number | null;
  detected_health_endpoint: string | null;  // Task 2: HEALTHCHECK 자동 감지 결과
  total_size: number;
}

export interface VulnpackSchedule {
  id: string;
  pack_number: number;
  label: string | null;
  service_ids: string[];
  service_names: Record<string, string> | null;
  scheduled_offset_minutes: number;
  status: string;
  actual_release_at: string | null;
}

export interface DeployPipeline {
  id: string;
  service_id: string;
  triggered_by: string;
  triggered_by_name: string | null;
  service_name: string | null;
  status: string;
  current_stage: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_detail: string | null;
  stages: DeployStage[];
}

export interface DeployStage {
  id: string;
  stage_name: string;
  stage_order: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  log_output: string | null;
  error_detail: string | null;
}

export interface Ticket {
  id: string;
  ticket_number: string;
  type: "dispute" | "violation";
  title: string;
  description: string;
  team_name: string | null;
  status: string;
  priority: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  discord_ticket_id: string | null;
  created_at: string;
}

export interface EmergencyStatus {
  is_halted: boolean;
  active_actions: EmergencyAction[];
}

export interface EmergencyAction {
  id: string;
  action_type: string;
  reason: string;
  executed_by: string;
  executed_by_name: string | null;
  executed_at: string;
}

export interface DashboardStats {
  active_teams: number;
  scoring_round: number;
  open_tickets: number;
  current_vulnpack: number;
  system_health: Record<string, "ok" | "degraded" | "down" | "not_connected" | "unknown">;
}

export interface AuditLog {
  id: string;
  actor_name: string;
  action: string;
  target_type: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

export type CompetitionStatus =
  | "draft"
  | "registration"
  | "ready"
  | "running"
  | "paused"
  | "finished"
  | "archived";

export interface Competition {
  id: string;
  name: string;
  description: string | null;
  status: CompetitionStatus;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  actual_start_at: string | null;
  actual_end_at: string | null;
  scoring_round_interval_seconds: number;
  max_teams: number;
  max_members_per_team: number;
  network_participant_subnet: string;
  network_ops_subnet: string;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string | null;
  team_count: number;
  current_round: number;
}

export interface CompetitionListItem {
  id: string;
  name: string;
  status: CompetitionStatus;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  actual_start_at: string | null;
  max_teams: number;
  created_at: string;
}

export interface CompetitionListResponse {
  items: CompetitionListItem[];
  total: number;
  page: number;
  size: number;
}

export interface StateTransitionResponse {
  id: string;
  status: CompetitionStatus;
  message: string;
  actual_start_at?: string;
  actual_end_at?: string;
  reason?: string;
  total_rounds?: number;
  final_rankings_count?: number;
}

// ── 팀 관리 ──
export type TeamStatus = "pending" | "approved" | "active" | "disqualified" | "withdrawn";
export type TeamMemberRole = "captain" | "member";
export type TeamMemberStatus = "pending" | "approved" | "rejected" | "left" | "kicked";

export interface TeamListItem {
  id: string;
  competition_id: string;
  name: string;
  team_code: string;
  captain_discord_id: string;
  subnet: string | null;
  gateway_ip: string | null;
  vpn_profile_issued: boolean;
  status: TeamStatus;
  member_count: number;
  registered_at: string;
  approved_at: string | null;
  ssh_configured: boolean;
}

export interface TeamListResponse {
  items: TeamListItem[];
  total: number;
  page: number;
  size: number;
}

export interface TeamDetail {
  id: string;
  competition_id: string;
  name: string;
  team_code: string;
  captain_discord_id: string;
  discord_role_id: string | null;
  subnet: string | null;
  gateway_ip: string | null;
  vpn_profile_issued: boolean;
  status: TeamStatus;
  registered_at: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string | null;
  ssh_port: number;
  ssh_user: string | null;
  ssh_configured: boolean;
}

export interface TeamMemberItem {
  id: string;
  discord_user_id: string;
  discord_username: string | null;
  role: TeamMemberRole;
  status: TeamMemberStatus;
  joined_at: string | null;
}

export interface TeamServiceItem {
  id: string;
  service_id: string;
  service_name: string | null;
  host_ip: string;
  port: number;
  container_id: string | null;
  status: string;
  last_health_check_at: string | null;
  last_health_check_result: boolean | null;
}

// ── 플래그 관리 ──
export type FlagVerdict = "correct" | "incorrect" | "expired" | "duplicate" | "own_flag" | "invalid_format";

export interface FlagItem {
  id: string;
  round_number: number;
  round_id: string;
  team_id: string;
  team_name: string;
  service_id: string;
  service_name: string;
  flag_value: string;
  is_active: boolean;
  planted_at: string | null;
  expires_at: string | null;
}

export interface FlagListResponse {
  items: FlagItem[];
  total: number;
  page: number;
  size: number;
}

export interface FlagSubmissionItem {
  id: string;
  competition_id: string;
  round_number: number | null;
  submitter_team_id: string;
  submitter_team_name: string;
  target_team_id: string | null;
  target_team_name: string | null;
  service_id: string | null;
  service_name: string | null;
  submitted_flag: string;
  verdict: FlagVerdict;
  submitter_discord_id: string | null;
  submitted_at: string;
}

export interface FlagSubmissionListResponse {
  items: FlagSubmissionItem[];
  total: number;
  page: number;
  size: number;
}

export interface FlagTeamAttackStat {
  team_id: string;
  team_name: string;
  total_submissions: number;
  correct_submissions: number;
  accuracy_rate: number;
  unique_teams_attacked: number;
}

export interface FlagTeamDefenseStat {
  team_id: string;
  team_name: string;
  flags_stolen: number;
  flags_total: number;
  defense_rate: number;
}

export interface FlagServiceStat {
  service_id: string;
  service_name: string;
  total_captures: number;
  capture_rate_per_round: number;
}

export interface FlagStatsResponse {
  competition_id: string;
  total_flags_generated: number;
  total_submissions: number;
  submissions_by_verdict: Record<string, number>;
  accuracy_rate: number;
  team_attack_stats: FlagTeamAttackStat[];
  team_defense_stats: FlagTeamDefenseStat[];
  service_stats: FlagServiceStat[];
}

// ── 네트워크 관제 ──
export type NetworkTeamStatus = "connected" | "isolated";

export interface NetworkTeamSummary {
  team_id: string;
  team_name: string;
  subnet: string | null;
  gateway_ip: string | null;
  status: NetworkTeamStatus;
  ping_ms: number | null;
  last_checked_at: string | null;
  isolated_at: string | null;
  isolation_reason: string | null;
}

export interface NetworkStatusResponse {
  competition_id: string;
  participant_subnet: string;
  ops_subnet: string;
  total_teams: number;
  teams_online: number;
  teams_isolated: number;
  is_all_isolated: boolean;
  teams: NetworkTeamSummary[];
}

export interface NetworkTeamService {
  service_name: string;
  host_ip: string;
  port: number;
  reachable: boolean;
  response_time_ms: number | null;
}

export interface NetworkTeamDetail {
  team_id: string;
  team_name: string;
  subnet: string | null;
  gateway_ip: string | null;
  status: NetworkTeamStatus;
  ping_ms: number | null;
  vpn_profile_issued: boolean;
  active_connections: number;
  services: NetworkTeamService[];
  last_checked_at: string | null;
}

export interface NetworkActionResponse {
  team_id?: string;
  team_name?: string;
  competition_id?: string;
  subnet?: string | null;
  status?: NetworkTeamStatus;
  message: string;
  reason: string;
  isolated_at?: string;
  restored_at?: string;
  is_all_isolated?: boolean;
  affected_teams?: number;
  restored_teams?: number;
}

// ── 서브넷 등록 ──
export type SubnetRegistrationStatus = "registered" | "unassigned";

export interface TeamSubnetInfo {
  team_id: string;
  team_name: string;
  team_code: string;
  subnet: string | null;
  gateway_ip: string | null;
  vpn_profile_issued: boolean;
  registration_status: SubnetRegistrationStatus;
  updated_at: string | null;
}

export interface SubnetListResponse {
  competition_id: string;
  total_teams: number;
  assigned_count: number;
  unassigned_count: number;
  vpn_issued_count: number;
  teams: TeamSubnetInfo[];
}

export interface SubnetAssignResponse {
  team_id: string;
  team_name: string;
  subnet: string;
  gateway_ip: string;
  message: string;
}

export interface SubnetAutoAssignResponse {
  competition_id: string;
  assigned_count: number;
  skipped_count: number;
  assignments: TeamSubnetInfo[];
  message: string;
}

// ── 배포 현황 ──
export type DeployStatusType = "completed" | "deploying" | "failed" | "pending" | "no_subnet";

export interface TeamDeployStatus {
  team_id: string;
  team_name: string;
  subnet: string | null;
  vulnpack_name: string | null;
  deploy_status: DeployStatusType;
  progress_pct: number;
  last_deploy_at: string | null;
}

export interface DeployStatusResponse {
  competition_id: string;
  total_teams: number;
  deployed_count: number;
  deploying_count: number;
  pending_count: number;
  teams: TeamDeployStatus[];
}

// ── 피드백 관리 ──
export type FeedbackCategory = "general" | "scoring" | "network" | "service" | "organization";

export interface FeedbackItem {
  id: string;
  competition_id: string;
  discord_user_id: string;
  discord_username: string | null;
  team_id: string | null;
  team_name: string | null;
  rating: number;
  content: string;
  category: FeedbackCategory;
  created_at: string;
}

export interface FeedbackListResponse {
  items: FeedbackItem[];
  total: number;
  page: number;
  size: number;
}

export interface FeedbackCategoryBreakdown {
  count: number;
  average_rating: number;
}

export interface FeedbackStatsResponse {
  competition_id: string;
  total_feedbacks: number;
  average_rating: number;
  rating_distribution: Record<string, number>;
  category_breakdown: Record<string, FeedbackCategoryBreakdown>;
  participation_rate: number;
}

// ── 대회 결과 ──
export interface ResultRanking {
  rank: number;
  team_name: string;
  team_id: string;
  total_score: number;
  attack_score: number;
  defense_score: number;
  sla_percentage: number;
  flags_captured: number;
  flags_lost: number;
}

export interface ResultServiceStat {
  service_name: string;
  service_id: string;
  total_flags_captured: number;
  average_sla: number;
  most_attacked_team: string | null;
}

export interface CompetitionResultsResponse {
  competition_id: string;
  competition_name: string;
  status: string;
  duration_hours: number;
  total_rounds: number;
  total_teams: number;
  total_flag_submissions: number;
  total_correct_flags: number;
  rankings: ResultRanking[];
  service_stats: ResultServiceStat[];
}

export interface TimelineEvent {
  timestamp: string;
  type: string;
  details: Record<string, unknown>;
}

export interface TimelineResponse {
  competition_id: string;
  total_rounds: number;
  events: TimelineEvent[];
}

// ── C-Guard ─────────────────────────────────────────────────
export interface CGuardSummary {
  total_sessions: number;
  active_sessions: number;
  blocked_sessions: number;
  restricted_sessions: number;
  c_guard_ok_count: number;
  total_events: number;
  active_bans: number;
}

export interface CGuardSession {
  session_id: string;
  user_id: string;
  username: string | null;
  team_name: string | null;
  status: string;
  decision_status: string | null;
  decision_reason_code: string | null;
  risk_score: number | null;
  last_heartbeat_at: string | null;
  last_ip: string | null;
  created_at: string;
}

export interface CGuardEvent {
  event_id: number;
  timestamp: string;
  event_type: string;
  severity: string;
  session_id: string;
  username: string | null;
  client_version: string;
  evidence: Record<string, unknown> | null;
}

export interface CGuardBan {
  ban_id: string;
  scope: string;
  target_id: string;
  reason: string | null;
  reason_code: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  status: string;
}

export interface CGuardAuditLog {
  audit_id: string;
  at: string;
  actor: string;
  action: string;
  object_type: string | null;
  object_id: string | null;
  detail: Record<string, unknown> | null;
}

// ── Discord Bot ──────────────────────────────────────────────
export type DiscordBotHealthStatus = "ok" | "degraded" | "down" | "unknown";

export interface DiscordBotSummary {
  bot_status: DiscordBotHealthStatus;
  bot_latency_ms: number | null;
  last_heartbeat_at: string | null;
  total_events: number;
  total_broadcasts: number;
  total_relays: number;
  total_cguard_events: number;
  recent_events_24h: number;
  recent_broadcasts_24h: number;
  recent_relays_24h: number;
  recent_cguard_events_24h: number;
}

export interface DiscordBotEvent {
  event_id: string | number;
  timestamp: string;
  log_type: string;
  event_key: string | null;
  actor_discord_id: string | null;
  actor_username: string | null;
  team_id: string | null;
  team_name: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
}

export interface DiscordBotBroadcast {
  broadcast_id: string | number;
  timestamp: string;
  kind: string;
  channel_id: string | null;
  channel_name: string | null;
  title: string | null;
  content: string | null;
  status: string;
  error_detail: string | null;
}

export interface DiscordBotRelay {
  relay_id: string | number;
  timestamp: string;
  event_type: string;
  channel_id: string | null;
  channel_name: string | null;
  payload_summary: string | null;
  payload: Record<string, unknown> | null;
}

export interface DiscordBotCGuardEvent {
  event_id: string | number;
  timestamp: string;
  discord_user_id: string | null;
  username: string | null;
  team_id: string | null;
  team_name: string | null;
  verified: boolean;
  reason: string | null;
}
