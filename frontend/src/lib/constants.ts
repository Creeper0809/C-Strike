export const STATUS_COLORS = {
  ok: "text-status-ok",
  warning: "text-status-warning",
  danger: "text-status-danger",
  info: "text-status-info",
  neutral: "text-status-neutral",
} as const;

export const SERVICE_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  draft: { label: "초안", color: "neutral" },
  active: { label: "활성", color: "ok" },
};

export const TICKET_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  open: { label: "열림", color: "danger" },
  in_progress: { label: "처리 중", color: "warning" },
  resolved: { label: "해결됨", color: "ok" },
  rejected: { label: "반려됨", color: "neutral" },
  escalated: { label: "상위 보고", color: "info" },
};

export const PRIORITY_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  low: { label: "낮음", color: "neutral" },
  medium: { label: "보통", color: "warning" },
  high: { label: "높음", color: "danger" },
  critical: { label: "긴급", color: "danger" },
};

export const COMPETITION_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  draft: { label: "초안", color: "neutral" },
  registration: { label: "등록 중", color: "info" },
  ready: { label: "준비 완료", color: "warning" },
  running: { label: "진행 중", color: "ok" },
  paused: { label: "일시중단", color: "danger" },
  finished: { label: "종료", color: "neutral" },
  archived: { label: "아카이브", color: "neutral" },
};

export const DEPLOY_STAGES = ["register", "validate", "prepare", "deploy", "verify"] as const;
export const DEPLOY_STAGE_LABELS: Record<string, string> = {
  register: "이미지 확인",
  validate: "서비스 검증",
  prepare: "네트워크 준비",
  deploy: "컨테이너 배포",
  verify: "최종 검증",
};

export const NAV_ITEMS = [
  { href: "/", label: "대시보드", icon: "LayoutDashboard" },
  { href: "/teams", label: "팀 관리", icon: "Users" },
  { href: "/services", label: "문제 관리", icon: "Shield" },
  { href: "/tickets", label: "티켓 관리", icon: "Ticket" },
  { href: "/emergency", label: "비상 통제", icon: "AlertTriangle", adminOnly: true },
  { href: "/operators", label: "유저 관리", icon: "UserCog", adminOnly: true },
  { href: "/audit", label: "감사 로그", icon: "ClipboardList" },
  { href: "/settings", label: "설정", icon: "Settings", adminOnly: true },
] as const;

export const TEAM_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  pending: { label: "승인 대기", color: "warning" },
  approved: { label: "승인됨", color: "info" },
  active: { label: "활성", color: "ok" },
  disqualified: { label: "실격", color: "danger" },
  withdrawn: { label: "탈퇴", color: "neutral" },
};

export const TEAM_MEMBER_ROLE_MAP: Record<string, string> = {
  captain: "팀장",
  member: "팀원",
};

export const TEAM_MEMBER_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  pending: { label: "대기", color: "warning" },
  approved: { label: "승인", color: "ok" },
  rejected: { label: "거부", color: "danger" },
  left: { label: "탈퇴", color: "neutral" },
  kicked: { label: "추방", color: "danger" },
};

export const FLAG_VERDICT_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  correct: { label: "정답", color: "ok" },
  incorrect: { label: "오답", color: "danger" },
  expired: { label: "만료", color: "warning" },
  duplicate: { label: "중복", color: "neutral" },
  own_flag: { label: "자기 플래그", color: "warning" },
  invalid_format: { label: "형식 오류", color: "danger" },
};

export const NETWORK_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  connected: { label: "연결됨", color: "ok" },
  isolated: { label: "격리됨", color: "danger" },
};

export const BUILD_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  building: { label: "빌드 중", color: "info" },
  success: { label: "빌드 성공", color: "ok" },
  failed: { label: "빌드 실패", color: "danger" },
};

export const ENV_TYPE_MAP: Record<string, string> = {
  dockerfile: "Dockerfile 업로드",
  image: "Docker 이미지",
};

export const FEEDBACK_CATEGORY_MAP: Record<string, { label: string }> = {
  general: { label: "전체" },
  scoring: { label: "채점" },
  network: { label: "네트워크" },
  service: { label: "서비스" },
  organization: { label: "운영" },
};

export const CGUARD_SESSION_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  ACTIVE: { label: "활성", color: "ok" },
  RESTRICTED: { label: "제한", color: "warning" },
  BLOCKED: { label: "차단", color: "danger" },
  OFFLINE: { label: "오프라인", color: "neutral" },
};

export const CGUARD_SEVERITY_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  low: { label: "낮음", color: "info" },
  medium: { label: "보통", color: "warning" },
  high: { label: "높음", color: "danger" },
  critical: { label: "긴급", color: "danger" },
};

export const CGUARD_BAN_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  ACTIVE: { label: "활성", color: "danger" },
  EXPIRED: { label: "만료", color: "neutral" },
  REVOKED: { label: "해제", color: "ok" },
};

// ── Discord Bot ─────────────────────────────────────────────
export const DISCORD_BOT_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  ok: { label: "정상", color: "ok" },
  degraded: { label: "저하", color: "warning" },
  down: { label: "중단", color: "danger" },
  unknown: { label: "알 수 없음", color: "neutral" },
};

export const DISCORD_LOG_TYPE_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  command: { label: "명령", color: "info" },
  interaction: { label: "상호작용", color: "info" },
  member_join: { label: "입장", color: "ok" },
  member_leave: { label: "퇴장", color: "neutral" },
  role_update: { label: "역할 변경", color: "warning" },
  error: { label: "오류", color: "danger" },
  system: { label: "시스템", color: "neutral" },
};

export const DISCORD_BROADCAST_KIND_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  announcement: { label: "공지", color: "info" },
  alert: { label: "경보", color: "danger" },
  notice: { label: "안내", color: "neutral" },
  scoring: { label: "채점", color: "ok" },
  emergency: { label: "비상", color: "danger" },
};

export const DISCORD_BROADCAST_STATUS_MAP: Record<string, { label: string; color: keyof typeof STATUS_COLORS }> = {
  sent: { label: "전송", color: "ok" },
  pending: { label: "대기", color: "warning" },
  failed: { label: "실패", color: "danger" },
  skipped: { label: "생략", color: "neutral" },
};
