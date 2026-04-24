"use strict";

const INVESTIGATION_FILTER_STORAGE_KEY = "antillm_admin_investigation_filters_v1";
const SESSION_FILTER_STORAGE_KEY = "antillm_admin_session_filters_v1";
const INVESTIGATION_AUTO_APPLY_STORAGE_KEY = "antillm_admin_investigation_auto_apply_v1";
const ALLOWED_SEVERITY_FILTERS = new Set(["", "low", "medium", "high", "critical"]);
const ALLOWED_VALIDATION_RULE_FILTERS = new Set([
  "",
  "replay_pattern",
  "bridge_counter_monotonic",
  "bridge_counter_gap",
  "bridge_nonce_presence",
  "bridge_nonce_reuse",
  "bridge_nonce_counter_consistency",
  "bridge_emitted_at_monotonic",
  "bridge_emitted_at_freshness",
  "bridge_staleness",
  "bridge_signature_verification",
  "bridge_session_binding_verification",
  "kernel_signal_burst",
  "session_binding",
  "source_presence",
  "source_expected_kernel_bridge"
]);
const ALLOWED_SESSION_STATUS_FILTERS = new Set(["", "ACTIVE", "WARN", "BLOCKED", "OFFLINE"]);
const ALLOWED_SESSION_UPLOAD_STATUS_FILTERS = new Set([
  "",
  "ok",
  "recovered",
  "degraded",
  "failed"
]);
const ALLOWED_SESSION_POLICY_REASON_FILTERS = new Set(["", "warn", "block", "required"]);
const KERNEL_INTEGRITY_WARN_REASON_CODE = "KERNEL_INTEGRITY_WARN";
const KERNEL_INTEGRITY_BLOCK_REASON_CODE = "KERNEL_INTEGRITY_WARN_BLOCK";
const KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE = "KERNEL_REQUIRED_SIGNAL_MISSING";
const KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE = "KERNEL_SIGNAL_RATE_TOO_LOW";
const CLIENT_AGENT_REQUIRED_REASON_CODE = "CLIENT_AGENT_REQUIRED";
const KERNEL_CONNECTION_REQUIRED_REASON_CODE = "KERNEL_CONNECTION_REQUIRED";
const SENSITIVE_REVIEW_ACTIONS = new Set(["mark_as_suspicious", "escalate", "clear_with_reason"]);
const RUNTIME_POLICY_SENSITIVE_FIELDS = new Set([
  "require_discord_linked",
  "require_discord_linked_action",
  "require_discord_linked_grace_sec",
  "cli_detection_action",
  "cli_confidence_threshold",
  "cli_min_evidence_count",
  "cli_enforcement_cooldown_sec",
  "cli_override_window_sec"
]);
const OPERATOR_TOAST_DURATION_MS = 5200;
const REASON_CODE_ACTION_TEMPLATES = Object.freeze({
  [CLIENT_AGENT_REQUIRED_REASON_CODE]: {
    action: "request_follow_up",
    reason:
      "Participant gate failed: antiLLM client agent is not running. Request participant remediation and re-verify.",
    template_code: "follow_up_client_agent_required",
    toast_level: "warn"
  },
  [KERNEL_CONNECTION_REQUIRED_REASON_CODE]: {
    action: "request_follow_up_kernel",
    reason:
      "Participant gate failed: kernel bridge is disconnected or driver is not loaded. Request kernel recovery and re-verify.",
    template_code: "follow_up_kernel_connection_required",
    toast_level: "error"
  },
  [KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE]: {
    action: "escalate",
    reason:
      "Kernel-required telemetry is missing for this protected session. Escalate for integrity review before allowing participation.",
    template_code: "escalate_kernel_required_signal_missing",
    toast_level: "error"
  },
  [KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE]: {
    action: "request_follow_up_kernel",
    reason:
      "Kernel signal rate is below enforced minimum policy. Request participant kernel bridge diagnostics and re-check session integrity.",
    template_code: "follow_up_kernel_signal_rate_too_low",
    toast_level: "error"
  },
  [KERNEL_INTEGRITY_BLOCK_REASON_CODE]: {
    action: "escalate",
    reason:
      "Kernel integrity warnings reached block policy. Escalate and request deeper host investigation.",
    template_code: "escalate_kernel_integrity_block",
    toast_level: "error"
  },
  [KERNEL_INTEGRITY_WARN_REASON_CODE]: {
    action: "request_follow_up_kernel",
    reason:
      "Kernel integrity warning detected. Request follow-up and collect additional kernel evidence before final decision.",
    template_code: "follow_up_kernel_integrity_warn",
    toast_level: "warn"
  }
});
const INVESTIGATION_FILTER_RELOAD_DEBOUNCE_MS = 280;
let investigationReloadTimer = null;

const state = {
  adminActor: "",
  adminRole: "",
  adminToken: "",
  adminKey: "",
  activeTab: "investigation",
  sessions: [],
  sessionsPage: {
    total: 0,
    offset: 0,
    limit: 20,
    has_more: false,
    next_offset: null
  },
  bans: [],
  bansPage: {
    total: 0,
    offset: 0,
    limit: 20,
    has_more: false,
    next_offset: null
  },
  auditLogs: [],
  auditPage: {
    total: 0,
    offset: 0,
    limit: 20,
    has_more: false,
    next_offset: null
  },
  reviewNotes: [],
  reviewNotesPage: {
    total: 0,
    offset: 0,
    limit: 20,
    has_more: false,
    next_offset: null
  },
  reviewActions: [],
  reviewActionsPage: {
    total: 0,
    offset: 0,
    limit: 20,
    has_more: false,
    next_offset: null
  },
  runtimeConfig: null,
  gateFailureCounters: null,
  qualityMetrics: null,
  qualityTimeseries: null,
  qualityTimeseriesSelectedLabel: null,
  selectedSessionId: null,
  selectedEvidenceIndex: null,
  viewModel: null,
  operatorAlertSnapshot: null,
  operatorToastSeq: 0
};

const dom = {
  adminAuthForm: document.getElementById("adminAuthForm"),
  adminUsernameInput: document.getElementById("adminUsernameInput"),
  adminPasswordInput: document.getElementById("adminPasswordInput"),
  adminKeyInput: document.getElementById("adminKeyInput"),
  adminAuthStatus: document.getElementById("adminAuthStatus"),
  tabInvestigationBtn: document.getElementById("tabInvestigationBtn"),
  tabBansBtn: document.getElementById("tabBansBtn"),
  tabAuditBtn: document.getElementById("tabAuditBtn"),
  reloadSessionsBtn: document.getElementById("reloadSessionsBtn"),
  sessionLimitInput: document.getElementById("sessionLimitInput"),
  sessionPrevBtn: document.getElementById("sessionPrevBtn"),
  sessionNextBtn: document.getElementById("sessionNextBtn"),
  sessionPageInfo: document.getElementById("sessionPageInfo"),
  sessionFilterState: document.getElementById("sessionFilterState"),
  sessionGateAlertBadge: document.getElementById("sessionGateAlertBadge"),
  sessionKernelBlockAlertBadge: document.getElementById("sessionKernelBlockAlertBadge"),
  sessionUploadFailedAlertBadge: document.getElementById("sessionUploadFailedAlertBadge"),
  operatorToastHost: document.getElementById("operatorToastHost"),
  reloadGateFailureCountersBtn: document.getElementById("reloadGateFailureCountersBtn"),
  gateFailureCountersState: document.getElementById("gateFailureCountersState"),
  gateFailureCountersTags: document.getElementById("gateFailureCountersTags"),
  runtimePolicyControlState: document.getElementById("runtimePolicyControlState"),
  policyRequireDiscordLinkedToggle: document.getElementById("policyRequireDiscordLinkedToggle"),
  policyRequireDiscordLinkedActionSelect: document.getElementById(
    "policyRequireDiscordLinkedActionSelect"
  ),
  policyRequireDiscordLinkedGraceSecInput: document.getElementById(
    "policyRequireDiscordLinkedGraceSecInput"
  ),
  policyCliDetectionActionSelect: document.getElementById("policyCliDetectionActionSelect"),
  policyCliConfidenceThresholdInput: document.getElementById("policyCliConfidenceThresholdInput"),
  policyCliMinEvidenceCountInput: document.getElementById("policyCliMinEvidenceCountInput"),
  policyCliEnforcementCooldownSecInput: document.getElementById(
    "policyCliEnforcementCooldownSecInput"
  ),
  policyCliOverrideWindowSecInput: document.getElementById("policyCliOverrideWindowSecInput"),
  runtimePolicyHighImpactConfirmCheckbox: document.getElementById(
    "runtimePolicyHighImpactConfirmCheckbox"
  ),
  runtimePolicyUpdateReasonInput: document.getElementById("runtimePolicyUpdateReasonInput"),
  saveRuntimePolicyBtn: document.getElementById("saveRuntimePolicyBtn"),
  reloadRuntimePolicyBtn: document.getElementById("reloadRuntimePolicyBtn"),
  qualityMetricsState: document.getElementById("qualityMetricsState"),
  qualityMetricsSummary: document.getElementById("qualityMetricsSummary"),
  qualityTimeseriesFromInput: document.getElementById("qualityTimeseriesFromInput"),
  qualityTimeseriesToInput: document.getElementById("qualityTimeseriesToInput"),
  qualityTimeseriesBucketsInput: document.getElementById("qualityTimeseriesBucketsInput"),
  reloadQualityTimeseriesBtn: document.getElementById("reloadQualityTimeseriesBtn"),
  qualityTimeseriesState: document.getElementById("qualityTimeseriesState"),
  qualityTimeseriesBody: document.getElementById("qualityTimeseriesBody"),
  qualityTimeseriesEmpty: document.getElementById("qualityTimeseriesEmpty"),
  qualityTimeseriesDetailState: document.getElementById("qualityTimeseriesDetailState"),
  qualityTimeseriesDetailTags: document.getElementById("qualityTimeseriesDetailTags"),
  qualityTimeseriesDetailRules: document.getElementById("qualityTimeseriesDetailRules"),
  sessionStatusFilter: document.getElementById("sessionStatusFilter"),
  sessionUploadStatusFilter: document.getElementById("sessionUploadStatusFilter"),
  sessionUploadRecoveredOnlyBtn: document.getElementById("sessionUploadRecoveredOnlyBtn"),
  sessionUploadDegradedOnlyBtn: document.getElementById("sessionUploadDegradedOnlyBtn"),
  sessionUploadFailedOnlyBtn: document.getElementById("sessionUploadFailedOnlyBtn"),
  sessionUploadFilterClearBtn: document.getElementById("sessionUploadFilterClearBtn"),
  sessionUploadRecoveredCount: document.getElementById("sessionUploadRecoveredCount"),
  sessionUploadDegradedCount: document.getElementById("sessionUploadDegradedCount"),
  sessionUploadFailedCount: document.getElementById("sessionUploadFailedCount"),
  sessionKernelPolicyOnly: document.getElementById("sessionKernelPolicyOnly"),
  sessionKernelWarnOnlyBtn: document.getElementById("sessionKernelWarnOnlyBtn"),
  sessionKernelBlockOnlyBtn: document.getElementById("sessionKernelBlockOnlyBtn"),
  sessionParticipantGateOnlyBtn: document.getElementById("sessionParticipantGateOnlyBtn"),
  sessionKernelFilterClearBtn: document.getElementById("sessionKernelFilterClearBtn"),
  sessionKernelWarnCount: document.getElementById("sessionKernelWarnCount"),
  sessionKernelBlockCount: document.getElementById("sessionKernelBlockCount"),
  sessionParticipantGateCount: document.getElementById("sessionParticipantGateCount"),
  sessionsState: document.getElementById("sessionsState"),
  sessionsList: document.getElementById("sessionsList"),
  severityFilter: document.getElementById("severityFilter"),
  eventTypeFilter: document.getElementById("eventTypeFilter"),
  collapseNoisyFilter: document.getElementById("collapseNoisyFilter"),
  validationWarnOnlyFilter: document.getElementById("validationWarnOnlyFilter"),
  llmDomainOnlyFilter: document.getElementById("llmDomainOnlyFilter"),
  validationRuleFilter: document.getElementById("validationRuleFilter"),
  autoApplyFiltersToggle: document.getElementById("autoApplyFiltersToggle"),
  applyFiltersBtn: document.getElementById("applyFiltersBtn"),
  presetValidationWarnBtn: document.getElementById("presetValidationWarnBtn"),
  presetNonceReuseBtn: document.getElementById("presetNonceReuseBtn"),
  presetFreshnessBtn: document.getElementById("presetFreshnessBtn"),
  presetLlmDomainBtn: document.getElementById("presetLlmDomainBtn"),
  presetClearBtn: document.getElementById("presetClearBtn"),
  viewLoading: document.getElementById("viewLoading"),
  viewError: document.getElementById("viewError"),
  viewContent: document.getElementById("viewContent"),
  investigationStates: document.getElementById("investigationStates"),
  runtimePolicyState: document.getElementById("runtimePolicyState"),
  sessionSummary: document.getElementById("sessionSummary"),
  riskOverview: document.getElementById("riskOverview"),
  timelineBody: document.getElementById("timelineBody"),
  timelineEmpty: document.getElementById("timelineEmpty"),
  evidenceMeta: document.getElementById("evidenceMeta"),
  evidenceRaw: document.getElementById("evidenceRaw"),
  evidenceParsed: document.getElementById("evidenceParsed"),
  notesAuthorFilter: document.getElementById("notesAuthorFilter"),
  notesRelatedEventTypeFilter: document.getElementById("notesRelatedEventTypeFilter"),
  notesUseSelectedEventTypeBtn: document.getElementById("notesUseSelectedEventTypeBtn"),
  notesRelatedSeverityFilter: document.getElementById("notesRelatedSeverityFilter"),
  notesUseSelectedSeverityBtn: document.getElementById("notesUseSelectedSeverityBtn"),
  notesFromInput: document.getElementById("notesFromInput"),
  notesToInput: document.getElementById("notesToInput"),
  notesLimitInput: document.getElementById("notesLimitInput"),
  reloadNotesBtn: document.getElementById("reloadNotesBtn"),
  notesPrevBtn: document.getElementById("notesPrevBtn"),
  notesNextBtn: document.getElementById("notesNextBtn"),
  notesPageInfo: document.getElementById("notesPageInfo"),
  notesState: document.getElementById("notesState"),
  notesList: document.getElementById("notesList"),
  noteForm: document.getElementById("noteForm"),
  noteText: document.getElementById("noteText"),
  actionsActorFilter: document.getElementById("actionsActorFilter"),
  actionsTypeFilter: document.getElementById("actionsTypeFilter"),
  actionsRelatedEventTypeFilter: document.getElementById("actionsRelatedEventTypeFilter"),
  actionsUseSelectedEventTypeBtn: document.getElementById("actionsUseSelectedEventTypeBtn"),
  actionsRelatedSeverityFilter: document.getElementById("actionsRelatedSeverityFilter"),
  actionsUseSelectedSeverityBtn: document.getElementById("actionsUseSelectedSeverityBtn"),
  actionsFromInput: document.getElementById("actionsFromInput"),
  actionsToInput: document.getElementById("actionsToInput"),
  actionsLimitInput: document.getElementById("actionsLimitInput"),
  reloadActionsBtn: document.getElementById("reloadActionsBtn"),
  actionsPrevBtn: document.getElementById("actionsPrevBtn"),
  actionsNextBtn: document.getElementById("actionsNextBtn"),
  actionsPageInfo: document.getElementById("actionsPageInfo"),
  actionsState: document.getElementById("actionsState"),
  actionsList: document.getElementById("actionsList"),
  actionForm: document.getElementById("actionForm"),
  actionType: document.getElementById("actionType"),
  quickMarkReviewedBtn: document.getElementById("quickMarkReviewedBtn"),
  quickRequestFollowUpBtn: document.getElementById("quickRequestFollowUpBtn"),
  quickReasonTemplateActionBtn: document.getElementById("quickReasonTemplateActionBtn"),
  actionReason: document.getElementById("actionReason"),
  bansPanel: document.getElementById("bansPanel"),
  auditPanel: document.getElementById("auditPanel"),
  banForm: document.getElementById("banForm"),
  banScope: document.getElementById("banScope"),
  banTargetId: document.getElementById("banTargetId"),
  banDurationSec: document.getElementById("banDurationSec"),
  banReason: document.getElementById("banReason"),
  banStatusFilter: document.getElementById("banStatusFilter"),
  banScopeFilter: document.getElementById("banScopeFilter"),
  banLimitInput: document.getElementById("banLimitInput"),
  reloadBansBtn: document.getElementById("reloadBansBtn"),
  banPrevBtn: document.getElementById("banPrevBtn"),
  banNextBtn: document.getElementById("banNextBtn"),
  banPageInfo: document.getElementById("banPageInfo"),
  bansState: document.getElementById("bansState"),
  bansList: document.getElementById("bansList"),
  auditActionFilter: document.getElementById("auditActionFilter"),
  auditActorFilter: document.getElementById("auditActorFilter"),
  auditFromInput: document.getElementById("auditFromInput"),
  auditToInput: document.getElementById("auditToInput"),
  auditLimitInput: document.getElementById("auditLimitInput"),
  reloadAuditBtn: document.getElementById("reloadAuditBtn"),
  auditPrevBtn: document.getElementById("auditPrevBtn"),
  auditNextBtn: document.getElementById("auditNextBtn"),
  auditPageInfo: document.getElementById("auditPageInfo"),
  auditState: document.getElementById("auditState"),
  auditList: document.getElementById("auditList")
};

function adminHeaders() {
  const headers = {};
  if (state.adminToken) {
    headers.Authorization = `Bearer ${state.adminToken}`;
  }
  if (state.adminKey.trim() !== "") {
    headers["x-admin-key"] = state.adminKey.trim();
  }
  return headers;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...adminHeaders()
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.code || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function normalizeInvestigationFilters(input = {}) {
  const severityRaw = typeof input.severity === "string" ? input.severity.trim().toLowerCase() : "";
  const severity = ALLOWED_SEVERITY_FILTERS.has(severityRaw) ? severityRaw : "";
  const eventType =
    typeof input.event_type === "string" ? input.event_type.trim().slice(0, 128) : "";
  const validationFailedRuleRaw =
    typeof input.validation_failed_rule === "string"
      ? input.validation_failed_rule.trim()
      : "";
  const validation_failed_rule = ALLOWED_VALIDATION_RULE_FILTERS.has(validationFailedRuleRaw)
    ? validationFailedRuleRaw
    : "";
  const collapseNoisy = Boolean(
    input.collapse_noisy === true ||
      input.collapse_noisy === 1 ||
      input.collapse_noisy === "1" ||
      input.collapse_noisy === "true"
  );
  const validationWarnOnly = Boolean(
    input.validation_warn_only === true ||
      input.validation_warn_only === 1 ||
      input.validation_warn_only === "1" ||
      input.validation_warn_only === "true"
  );
  const llmDomainOnly = Boolean(
    input.llm_domain_only === true ||
      input.llm_domain_only === 1 ||
      input.llm_domain_only === "1" ||
      input.llm_domain_only === "true"
  );

  return {
    severity,
    event_type: eventType,
    validation_failed_rule,
    collapse_noisy: collapseNoisy,
    validation_warn_only: validationWarnOnly,
    llm_domain_only: llmDomainOnly
  };
}

function normalizeSessionFilters(input = {}) {
  const statusRaw = typeof input.status === "string" ? input.status.trim().toUpperCase() : "";
  const status = ALLOWED_SESSION_STATUS_FILTERS.has(statusRaw) ? statusRaw : "";
  const uploadStatusRaw =
    typeof input.upload_status === "string" ? input.upload_status.trim().toLowerCase() : "";
  const upload_status = ALLOWED_SESSION_UPLOAD_STATUS_FILTERS.has(uploadStatusRaw)
    ? uploadStatusRaw
    : "";
  const kernelPolicyOnlyRaw = Boolean(
    input.kernel_policy_only === true ||
      input.kernel_policy_only === 1 ||
      input.kernel_policy_only === "1" ||
      input.kernel_policy_only === "true"
  );
  const reasonRaw =
    typeof input.kernel_policy_reason === "string"
      ? input.kernel_policy_reason.trim().toLowerCase()
      : "";
  const kernel_policy_reason = ALLOWED_SESSION_POLICY_REASON_FILTERS.has(reasonRaw)
    ? reasonRaw
    : "";
  const kernel_policy_only = kernelPolicyOnlyRaw || kernel_policy_reason !== "";
  const participant_gate_only = Boolean(
    input.participant_gate_only === true ||
      input.participant_gate_only === 1 ||
      input.participant_gate_only === "1" ||
      input.participant_gate_only === "true"
  );
  return {
    status,
    upload_status,
    kernel_policy_only,
    kernel_policy_reason,
    participant_gate_only
  };
}

function inferSessionKernelPreset(filters) {
  const normalized = normalizeSessionFilters(filters);
  if (!normalized.kernel_policy_only && normalized.kernel_policy_reason === "") return "clear";
  if (normalized.kernel_policy_only && normalized.kernel_policy_reason === "warn") return "warn";
  if (normalized.kernel_policy_only && normalized.kernel_policy_reason === "block") return "block";
  return "custom";
}

function inferSessionUploadPreset(filters) {
  const normalized = normalizeSessionFilters(filters);
  if (!normalized.upload_status) return "clear";
  if (
    normalized.upload_status === "recovered" ||
    normalized.upload_status === "degraded" ||
    normalized.upload_status === "failed"
  ) {
    return normalized.upload_status;
  }
  return "custom";
}

function isParticipantGateReasonCode(reasonCode) {
  return (
    reasonCode === CLIENT_AGENT_REQUIRED_REASON_CODE ||
    reasonCode === KERNEL_CONNECTION_REQUIRED_REASON_CODE
  );
}

function updateSessionKernelPresetUi(filters) {
  const activePreset = inferSessionKernelPreset(filters);
  const entries = [
    [dom.sessionKernelWarnOnlyBtn, "warn"],
    [dom.sessionKernelBlockOnlyBtn, "block"],
    [dom.sessionKernelFilterClearBtn, "clear"]
  ];
  for (const [button, preset] of entries) {
    const isActive = activePreset === preset;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
  updateSessionKernelQuickFilterBadges();
  updateSessionParticipantGateQuickFilterBadge(filters);
}

function updateSessionUploadPresetUi(filters) {
  const activePreset = inferSessionUploadPreset(filters);
  const entries = [
    [dom.sessionUploadRecoveredOnlyBtn, "recovered"],
    [dom.sessionUploadDegradedOnlyBtn, "degraded"],
    [dom.sessionUploadFailedOnlyBtn, "failed"],
    [dom.sessionUploadFilterClearBtn, "clear"]
  ];
  for (const [button, preset] of entries) {
    const isActive = activePreset === preset;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
  updateSessionUploadQuickFilterBadges();
}

function updateSessionParticipantGateQuickFilterBadge(filters) {
  const normalized = normalizeSessionFilters(filters);
  const active = normalized.participant_gate_only === true;
  dom.sessionParticipantGateOnlyBtn.classList.toggle("active", active);
  dom.sessionParticipantGateOnlyBtn.setAttribute("aria-pressed", active ? "true" : "false");
}

function updateSessionKernelQuickFilterBadges() {
  const warnCount = state.sessions.filter(
    (item) => item && item.decision_reason_code === KERNEL_INTEGRITY_WARN_REASON_CODE
  ).length;
  const blockCount = state.sessions.filter((item) => {
    if (!item) return false;
    return (
      item.decision_reason_code === KERNEL_INTEGRITY_BLOCK_REASON_CODE ||
      item.decision_reason_code === KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE ||
      item.decision_reason_code === KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE
    );
  }).length;
  dom.sessionKernelWarnCount.textContent = String(warnCount);
  dom.sessionKernelBlockCount.textContent = String(blockCount);
  const gateCount = state.sessions.filter(
    (item) => item && isParticipantGateReasonCode(item.decision_reason_code)
  ).length;
  dom.sessionParticipantGateCount.textContent = String(gateCount);
}

function resolveSessionUploadStatus(session) {
  if (!session || typeof session !== "object") return "";
  const directStatus =
    typeof session.upload_status === "string" ? session.upload_status.trim().toLowerCase() : "";
  if (directStatus) return directStatus;
  const summary =
    session.upload_status_summary && typeof session.upload_status_summary === "object"
      ? session.upload_status_summary
      : null;
  if (!summary) return "";
  const refreshFailedBatches = Number(summary.auth_refresh_failed_batches || 0);
  if (refreshFailedBatches > 0) return "failed";
  return typeof summary.status === "string" ? summary.status.trim().toLowerCase() : "";
}

function updateSessionUploadQuickFilterBadges() {
  let recoveredCount = 0;
  let degradedCount = 0;
  let failedCount = 0;
  for (const session of state.sessions) {
    const status = resolveSessionUploadStatus(session);
    if (status === "recovered") recoveredCount += 1;
    else if (status === "degraded") degradedCount += 1;
    else if (status === "failed") failedCount += 1;
  }
  dom.sessionUploadRecoveredCount.textContent = String(recoveredCount);
  dom.sessionUploadDegradedCount.textContent = String(degradedCount);
  dom.sessionUploadFailedCount.textContent = String(failedCount);
}

function setStateTagTone(element, tone, text) {
  if (!element) return;
  element.classList.add("state-tag", "alert-badge");
  element.classList.remove("ok", "warn", "error");
  element.classList.add(tone);
  element.textContent = text;
}

function summarizeOperatorAlerts(sessions) {
  const summary = {
    gateViolations: 0,
    kernelBlocks: 0,
    kernelWarns: 0,
    uploadFailed: 0
  };
  for (const session of sessions || []) {
    if (!session) continue;
    const reasonCode = session.decision_reason_code;
    if (isParticipantGateReasonCode(reasonCode)) summary.gateViolations += 1;
    if (
      reasonCode === KERNEL_INTEGRITY_BLOCK_REASON_CODE ||
      reasonCode === KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE ||
      reasonCode === KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE
    ) {
      summary.kernelBlocks += 1;
    } else if (reasonCode === KERNEL_INTEGRITY_WARN_REASON_CODE) {
      summary.kernelWarns += 1;
    }
    if (resolveSessionUploadStatus(session) === "failed") {
      summary.uploadFailed += 1;
    }
  }
  return summary;
}

function updateOperatorAlertBadges(summary) {
  setStateTagTone(
    dom.sessionGateAlertBadge,
    summary.gateViolations > 0 ? "error" : "ok",
    `gate_violations:${summary.gateViolations}`
  );
  const kernelBlockTone =
    summary.kernelBlocks > 0 ? "error" : summary.kernelWarns > 0 ? "warn" : "ok";
  setStateTagTone(
    dom.sessionKernelBlockAlertBadge,
    kernelBlockTone,
    `kernel_blocks:${summary.kernelBlocks}`
  );
  const uploadFailedTone = summary.uploadFailed > 0 ? "warn" : "ok";
  setStateTagTone(
    dom.sessionUploadFailedAlertBadge,
    uploadFailedTone,
    `upload_failed:${summary.uploadFailed}`
  );
}

function shouldEmitOperatorAlertToasts(filters) {
  const normalized = normalizeSessionFilters(filters || {});
  return (
    normalized.status === "" &&
    normalized.upload_status === "" &&
    normalized.kernel_policy_only === false &&
    normalized.participant_gate_only === false
  );
}

function showOperatorToast(level, message) {
  if (!dom.operatorToastHost || !message) return;
  const toast = document.createElement("div");
  toast.className = `operator-toast ${level}`;
  toast.textContent = message;
  const currentSeq = ++state.operatorToastSeq;
  toast.dataset.seq = String(currentSeq);
  dom.operatorToastHost.appendChild(toast);
  window.setTimeout(() => {
    if (!dom.operatorToastHost || !toast.parentElement) return;
    toast.remove();
  }, OPERATOR_TOAST_DURATION_MS);
}

function maybeEmitOperatorAlertToasts(summary, filters) {
  if (!shouldEmitOperatorAlertToasts(filters)) {
    state.operatorAlertSnapshot = summary;
    return;
  }
  const previous = state.operatorAlertSnapshot;
  state.operatorAlertSnapshot = summary;
  if (!previous) {
    if (summary.gateViolations > 0 || summary.kernelBlocks > 0 || summary.uploadFailed > 0) {
      showOperatorToast(
        summary.gateViolations > 0 || summary.kernelBlocks > 0 ? "error" : "warn",
        `Operator alerts active: gate=${summary.gateViolations}, kernel_blocks=${summary.kernelBlocks}, upload_failed=${summary.uploadFailed}`
      );
    }
    return;
  }

  if (summary.gateViolations > previous.gateViolations) {
    showOperatorToast(
      "error",
      `Gate violations increased: ${previous.gateViolations} -> ${summary.gateViolations}`
    );
  }
  if (summary.kernelBlocks > previous.kernelBlocks) {
    showOperatorToast(
      "error",
      `Kernel block sessions increased: ${previous.kernelBlocks} -> ${summary.kernelBlocks}`
    );
  }
  if (summary.uploadFailed > previous.uploadFailed) {
    showOperatorToast(
      "warn",
      `Upload failed sessions increased: ${previous.uploadFailed} -> ${summary.uploadFailed}`
    );
  }
}

function renderSessionFilterState(filters) {
  const normalized = normalizeSessionFilters(filters);
  const tags = [];
  if (normalized.status) {
    tags.push({ text: `status:${normalized.status}`, tone: "ok" });
  }
  if (normalized.upload_status) {
    const tone =
      normalized.upload_status === "failed"
        ? "error"
        : normalized.upload_status === "degraded"
          ? "warn"
          : "ok";
    tags.push({ text: `upload:${normalized.upload_status}`, tone });
  }
  if (!normalized.kernel_policy_only) {
    tags.push({ text: "kernel_policy:all", tone: "ok" });
  } else if (normalized.kernel_policy_reason === "warn") {
    tags.push({ text: "kernel_policy:warn", tone: "warn" });
  } else if (normalized.kernel_policy_reason === "block") {
    tags.push({ text: "kernel_policy:block", tone: "error" });
  } else if (normalized.kernel_policy_reason === "required") {
    tags.push({ text: "kernel_policy:required", tone: "error" });
  } else {
    tags.push({ text: "kernel_policy:any", tone: "warn" });
  }
  if (normalized.participant_gate_only) {
    tags.push({ text: "participant_gate:only", tone: "error" });
  }
  dom.sessionFilterState.innerHTML = "";
  for (const tag of tags) {
    const element = document.createElement("span");
    element.className = `state-tag ${tag.tone}`;
    element.textContent = tag.text;
    dom.sessionFilterState.appendChild(element);
  }
}

function readSessionFiltersFromDom() {
  return normalizeSessionFilters({
    status: dom.sessionStatusFilter.value,
    upload_status: dom.sessionUploadStatusFilter.value,
    kernel_policy_only: dom.sessionKernelPolicyOnly.checked,
    kernel_policy_reason: dom.sessionKernelPolicyOnly.dataset.reason || "",
    participant_gate_only: dom.sessionParticipantGateOnlyBtn.classList.contains("active")
  });
}

function applySessionFiltersToDom(filters) {
  const normalized = normalizeSessionFilters(filters);
  dom.sessionStatusFilter.value = normalized.status;
  dom.sessionUploadStatusFilter.value = normalized.upload_status;
  dom.sessionKernelPolicyOnly.checked = normalized.kernel_policy_only;
  dom.sessionKernelPolicyOnly.dataset.reason = normalized.kernel_policy_reason;
  updateSessionKernelPresetUi(normalized);
  updateSessionUploadPresetUi(normalized);
  updateSessionParticipantGateQuickFilterBadge(normalized);
}

function readSessionFiltersFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const hasRelevantParam =
      params.has("session_status") ||
      params.has("session_upload_status") ||
      params.has("session_kernel_policy_only") ||
      params.has("session_kernel_policy_reason") ||
      params.has("session_participant_gate_only");
    if (!hasRelevantParam) return null;
    return normalizeSessionFilters({
      status: params.get("session_status") || "",
      upload_status: params.get("session_upload_status") || "",
      kernel_policy_only: params.get("session_kernel_policy_only") || "",
      kernel_policy_reason: params.get("session_kernel_policy_reason") || "",
      participant_gate_only: params.get("session_participant_gate_only") || ""
    });
  } catch (_error) {
    return null;
  }
}

function writeSessionFiltersToUrl(filters) {
  try {
    const normalized = normalizeSessionFilters(filters);
    const current = new URL(window.location.href);
    const params = current.searchParams;
    if (normalized.status) params.set("session_status", normalized.status);
    else params.delete("session_status");
    if (normalized.upload_status) {
      params.set("session_upload_status", normalized.upload_status);
    } else {
      params.delete("session_upload_status");
    }
    if (normalized.kernel_policy_only) params.set("session_kernel_policy_only", "1");
    else params.delete("session_kernel_policy_only");
    if (normalized.kernel_policy_reason) {
      params.set("session_kernel_policy_reason", normalized.kernel_policy_reason);
    } else {
      params.delete("session_kernel_policy_reason");
    }
    if (normalized.participant_gate_only) {
      params.set("session_participant_gate_only", "1");
    } else {
      params.delete("session_participant_gate_only");
    }
    const query = params.toString();
    const nextUrl = `${current.pathname}${query ? `?${query}` : ""}${current.hash}`;
    window.history.replaceState(null, "", nextUrl);
  } catch (_error) {
    // ignore URL sync failures in unsupported environments
  }
}

function readSessionFiltersFromStorage() {
  try {
    const raw = window.localStorage.getItem(SESSION_FILTER_STORAGE_KEY);
    if (!raw) return null;
    return normalizeSessionFilters(JSON.parse(raw));
  } catch (_error) {
    return null;
  }
}

function writeSessionFiltersToStorage(filters) {
  try {
    const normalized = normalizeSessionFilters(filters);
    window.localStorage.setItem(SESSION_FILTER_STORAGE_KEY, JSON.stringify(normalized));
  } catch (_error) {
    // ignore local storage failures in private mode / restricted environments
  }
}

function syncSessionFilters(filters) {
  const normalized = normalizeSessionFilters(filters);
  applySessionFiltersToDom(normalized);
  renderSessionFilterState(normalized);
  writeSessionFiltersToStorage(normalized);
  writeSessionFiltersToUrl(normalized);
}

function normalizeSessionId(input) {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value) return null;
  return value.slice(0, 256);
}

function readInvestigationFiltersFromDom() {
  return normalizeInvestigationFilters({
    severity: dom.severityFilter.value,
    event_type: dom.eventTypeFilter.value,
    validation_failed_rule: dom.validationRuleFilter.value,
    collapse_noisy: dom.collapseNoisyFilter.checked,
    validation_warn_only: dom.validationWarnOnlyFilter.checked,
    llm_domain_only: dom.llmDomainOnlyFilter.checked
  });
}

function applyInvestigationFiltersToDom(filters) {
  const normalized = normalizeInvestigationFilters(filters);
  dom.severityFilter.value = normalized.severity;
  dom.eventTypeFilter.value = normalized.event_type;
  dom.validationRuleFilter.value = normalized.validation_failed_rule;
  dom.collapseNoisyFilter.checked = normalized.collapse_noisy;
  dom.validationWarnOnlyFilter.checked = normalized.validation_warn_only;
  dom.llmDomainOnlyFilter.checked = normalized.llm_domain_only;
}

function readInvestigationFiltersFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const hasRelevantParam =
      params.has("severity") ||
      params.has("event_type") ||
      params.has("validation_failed_rule") ||
      params.has("collapse_noisy") ||
      params.has("validation_warn_only") ||
      params.has("llm_domain_only");
    if (!hasRelevantParam) return null;
    return normalizeInvestigationFilters({
      severity: params.get("severity") || "",
      event_type: params.get("event_type") || "",
      validation_failed_rule: params.get("validation_failed_rule") || "",
      collapse_noisy: params.get("collapse_noisy") || "",
      validation_warn_only: params.get("validation_warn_only") || "",
      llm_domain_only: params.get("llm_domain_only") || ""
    });
  } catch (_error) {
    return null;
  }
}

function readSelectedSessionFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeSessionId(params.get("session_id"));
  } catch (_error) {
    return null;
  }
}

function writeSelectedSessionToUrl(sessionId) {
  try {
    const normalized = normalizeSessionId(sessionId);
    const current = new URL(window.location.href);
    const params = current.searchParams;
    if (normalized) params.set("session_id", normalized);
    else params.delete("session_id");
    const query = params.toString();
    const nextUrl = `${current.pathname}${query ? `?${query}` : ""}${current.hash}`;
    window.history.replaceState(null, "", nextUrl);
  } catch (_error) {
    // ignore URL sync failures in unsupported environments
  }
}

function writeInvestigationFiltersToUrl(filters) {
  try {
    const normalized = normalizeInvestigationFilters(filters);
    const current = new URL(window.location.href);
    const params = current.searchParams;
    if (normalized.severity) params.set("severity", normalized.severity);
    else params.delete("severity");
    if (normalized.event_type) params.set("event_type", normalized.event_type);
    else params.delete("event_type");
    if (normalized.validation_failed_rule) {
      params.set("validation_failed_rule", normalized.validation_failed_rule);
    } else {
      params.delete("validation_failed_rule");
    }
    if (normalized.collapse_noisy) params.set("collapse_noisy", "1");
    else params.delete("collapse_noisy");
    if (normalized.validation_warn_only) params.set("validation_warn_only", "1");
    else params.delete("validation_warn_only");
    if (normalized.llm_domain_only) params.set("llm_domain_only", "1");
    else params.delete("llm_domain_only");
    const query = params.toString();
    const nextUrl = `${current.pathname}${query ? `?${query}` : ""}${current.hash}`;
    window.history.replaceState(null, "", nextUrl);
  } catch (_error) {
    // ignore URL sync failures in unsupported environments
  }
}

function readInvestigationFiltersFromStorage() {
  try {
    const raw = window.localStorage.getItem(INVESTIGATION_FILTER_STORAGE_KEY);
    if (!raw) return null;
    return normalizeInvestigationFilters(JSON.parse(raw));
  } catch (_error) {
    return null;
  }
}

function writeInvestigationFiltersToStorage(filters) {
  try {
    const normalized = normalizeInvestigationFilters(filters);
    window.localStorage.setItem(INVESTIGATION_FILTER_STORAGE_KEY, JSON.stringify(normalized));
  } catch (_error) {
    // ignore local storage failures in private mode / restricted environments
  }
}

function readInvestigationAutoApplyFromStorage() {
  try {
    const raw = window.localStorage.getItem(INVESTIGATION_AUTO_APPLY_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch (_error) {
    return null;
  }
}

function writeInvestigationAutoApplyToStorage(enabled) {
  try {
    window.localStorage.setItem(INVESTIGATION_AUTO_APPLY_STORAGE_KEY, enabled ? "1" : "0");
  } catch (_error) {
    // ignore local storage failures in private mode / restricted environments
  }
}

function syncInvestigationFilters(filters) {
  const normalized = normalizeInvestigationFilters(filters);
  writeInvestigationFiltersToStorage(normalized);
  writeInvestigationFiltersToUrl(normalized);
  updateInvestigationPresetUi(normalized);
}

function inferInvestigationPreset(filters) {
  const normalized = normalizeInvestigationFilters(filters);
  const isClear =
    normalized.severity === "" &&
    normalized.event_type === "" &&
    normalized.validation_failed_rule === "" &&
    normalized.collapse_noisy === false &&
    normalized.validation_warn_only === false &&
    normalized.llm_domain_only === false;
  if (isClear) return "clear";

  const isValidationWarn =
    normalized.severity === "" &&
    normalized.event_type === "" &&
    normalized.validation_failed_rule === "" &&
    normalized.collapse_noisy === false &&
    normalized.validation_warn_only === true &&
    normalized.llm_domain_only === false;
  if (isValidationWarn) return "validation_warn";

  const isNonceReuse =
    normalized.severity === "" &&
    normalized.event_type === "KERNEL_TAMPER_SIGNAL" &&
    normalized.validation_failed_rule === "bridge_nonce_reuse" &&
    normalized.collapse_noisy === false &&
    normalized.validation_warn_only === false &&
    normalized.llm_domain_only === false;
  if (isNonceReuse) return "bridge_nonce_reuse";

  const isFreshness =
    normalized.severity === "" &&
    normalized.event_type === "KERNEL_TAMPER_SIGNAL" &&
    normalized.validation_failed_rule === "bridge_emitted_at_freshness" &&
    normalized.collapse_noisy === false &&
    normalized.validation_warn_only === false &&
    normalized.llm_domain_only === false;
  if (isFreshness) return "bridge_freshness";

  const isLlmDomain =
    normalized.severity === "" &&
    normalized.event_type === "" &&
    normalized.validation_failed_rule === "" &&
    normalized.collapse_noisy === false &&
    normalized.validation_warn_only === false &&
    normalized.llm_domain_only === true;
  if (isLlmDomain) return "llm_domain";

  return "custom";
}

function updateInvestigationPresetUi(filters) {
  const activePreset = inferInvestigationPreset(filters);
  const entries = [
    [dom.presetValidationWarnBtn, "validation_warn"],
    [dom.presetNonceReuseBtn, "bridge_nonce_reuse"],
    [dom.presetFreshnessBtn, "bridge_freshness"],
    [dom.presetLlmDomainBtn, "llm_domain"],
    [dom.presetClearBtn, "clear"]
  ];
  for (const [button, preset] of entries) {
    const isActive = activePreset === preset;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

async function applyInvestigationPreset(preset) {
  const next = (() => {
    if (preset === "validation_warn") {
      return {
        severity: "",
        event_type: "",
        validation_failed_rule: "",
        collapse_noisy: false,
        validation_warn_only: true
      };
    }
    if (preset === "bridge_nonce_reuse") {
      return {
        severity: "",
        event_type: "KERNEL_TAMPER_SIGNAL",
        validation_failed_rule: "bridge_nonce_reuse",
        collapse_noisy: false,
        validation_warn_only: false
      };
    }
    if (preset === "bridge_freshness") {
      return {
        severity: "",
        event_type: "KERNEL_TAMPER_SIGNAL",
        validation_failed_rule: "bridge_emitted_at_freshness",
        collapse_noisy: false,
        validation_warn_only: false,
        llm_domain_only: false
      };
    }
    if (preset === "llm_domain") {
      return {
        severity: "",
        event_type: "",
        validation_failed_rule: "",
        collapse_noisy: false,
        validation_warn_only: false,
        llm_domain_only: true
      };
    }
    return {
      severity: "",
      event_type: "",
      validation_failed_rule: "",
      collapse_noisy: false,
      validation_warn_only: false,
      llm_domain_only: false
    };
  })();

  applyInvestigationFiltersToDom(next);
  syncInvestigationFilters(next);
  if (!state.selectedSessionId) return false;
  state.selectedEvidenceIndex = null;
  await loadInvestigation(state.selectedSessionId);
}

function clearInvestigationReloadTimer() {
  if (investigationReloadTimer === null) return;
  window.clearTimeout(investigationReloadTimer);
  investigationReloadTimer = null;
}

function shouldAutoApplyInvestigationFilters() {
  return Boolean(dom.autoApplyFiltersToggle && dom.autoApplyFiltersToggle.checked);
}

function scheduleInvestigationReload({ immediate = false, resetEvidence = true } = {}) {
  if (!state.selectedSessionId) return;
  const executeReload = () => {
    if (!state.selectedSessionId) return;
    if (resetEvidence) state.selectedEvidenceIndex = null;
    void loadInvestigation(state.selectedSessionId);
  };
  clearInvestigationReloadTimer();
  if (immediate) {
    executeReload();
    return;
  }
  investigationReloadTimer = window.setTimeout(() => {
    investigationReloadTimer = null;
    executeReload();
  }, INVESTIGATION_FILTER_RELOAD_DEBOUNCE_MS);
}

function setViewState({ loading = false, error = null, showContent = false }) {
  dom.viewLoading.classList.toggle("hidden", !loading);
  dom.viewError.classList.toggle("hidden", !error);
  dom.viewContent.classList.toggle("hidden", !showContent);
  dom.viewError.textContent = error || "";
}

function setSessionsState(message) {
  dom.sessionsState.textContent = message;
  dom.sessionsState.classList.toggle("hidden", message === "");
}

function setQualityMetricsState(message) {
  dom.qualityMetricsState.textContent = message;
  dom.qualityMetricsState.classList.toggle("hidden", message === "");
}

function setGateFailureCountersState(message) {
  dom.gateFailureCountersState.textContent = message;
  dom.gateFailureCountersState.classList.toggle("hidden", message === "");
}

function setRuntimePolicyControlState(message) {
  dom.runtimePolicyControlState.textContent = message;
  dom.runtimePolicyControlState.classList.toggle("hidden", message === "");
}

function setQualityTimeseriesState(message) {
  dom.qualityTimeseriesState.textContent = message;
  dom.qualityTimeseriesState.classList.toggle("hidden", message === "");
}

function setQualityTimeseriesDetailState(message) {
  dom.qualityTimeseriesDetailState.textContent = message;
  dom.qualityTimeseriesDetailState.classList.toggle("hidden", message === "");
}

function resetQualityTimeseriesDetail(message = "Select a day row to inspect failed-rule details.") {
  state.qualityTimeseriesSelectedLabel = null;
  dom.qualityTimeseriesDetailTags.innerHTML = "";
  dom.qualityTimeseriesDetailRules.innerHTML = "";
  setQualityTimeseriesDetailState(message);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toDatetimeLocalValue(value) {
  if (!value) return "";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return "";
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`;
}

function setDefaultTimeseriesRange() {
  const now = Date.now();
  const from = new Date(now - 6 * 24 * 60 * 60 * 1000);
  from.setHours(0, 0, 0, 0);
  dom.qualityTimeseriesFromInput.value = toDatetimeLocalValue(from.toISOString());
  dom.qualityTimeseriesToInput.value = toDatetimeLocalValue(new Date(now).toISOString());
}

function formatMetricPercent(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function renderDetectionQualityTimeseries() {
  dom.qualityTimeseriesBody.innerHTML = "";
  const payload = state.qualityTimeseries;
  const buckets = payload && Array.isArray(payload.buckets) ? payload.buckets : [];
  const selectedLabel = state.qualityTimeseriesSelectedLabel;
  dom.qualityTimeseriesEmpty.classList.toggle("hidden", buckets.length > 0);
  if (buckets.length === 0) {
    resetQualityTimeseriesDetail();
    setQualityTimeseriesState("No timeseries buckets available.");
    return;
  }

  for (const bucket of buckets) {
    const rates = bucket && typeof bucket.rates === "object" ? bucket.rates : {};
    const counters = bucket && typeof bucket.counters === "object" ? bucket.counters : {};
    const kernelTrust =
      bucket && typeof bucket.kernel_signal_trust === "object" ? bucket.kernel_signal_trust : {};
    const kernelCounters =
      kernelTrust && typeof kernelTrust.counters === "object" ? kernelTrust.counters : {};
    const tr = document.createElement("tr");
    tr.className = "quality-timeseries-row";
    if (selectedLabel && bucket.label === selectedLabel) {
      tr.classList.add("active");
    }
    tr.innerHTML = `
      <td>${bucket.label || "-"}</td>
      <td>${Number(counters.sessions_reviewed || 0)}</td>
      <td>${formatMetricPercent(rates.precision)}</td>
      <td>${formatMetricPercent(rates.recall)}</td>
      <td>${formatMetricPercent(rates.false_positive_rate)}</td>
      <td>${formatMetricPercent(rates.false_negative_rate)}</td>
      <td>${Number(kernelCounters.validation_warn_events || 0)}/${Number(
        kernelCounters.total_kernel_events || 0
      )}</td>
    `;
    tr.addEventListener("click", () => {
      state.qualityTimeseriesSelectedLabel = bucket.label || null;
      renderDetectionQualityTimeseries();
    });
    dom.qualityTimeseriesBody.appendChild(tr);
  }

  const hasMore = payload && payload.has_more_range ? " (truncated by bucket limit)" : "";
  setQualityTimeseriesState(`Loaded ${buckets.length} daily buckets${hasMore}.`);
  renderDetectionQualityTimeseriesDetail();
}

function renderDetectionQualityTimeseriesDetail() {
  dom.qualityTimeseriesDetailTags.innerHTML = "";
  dom.qualityTimeseriesDetailRules.innerHTML = "";

  const payload = state.qualityTimeseries;
  const buckets = payload && Array.isArray(payload.buckets) ? payload.buckets : [];
  if (buckets.length === 0) {
    setQualityTimeseriesDetailState("Select a day row to inspect failed-rule details.");
    return;
  }

  const selectedLabel = state.qualityTimeseriesSelectedLabel;
  if (!selectedLabel) {
    setQualityTimeseriesDetailState("Select a day row to inspect failed-rule details.");
    return;
  }

  const selectedBucket = buckets.find((bucket) => bucket && bucket.label === selectedLabel);
  if (!selectedBucket) {
    setQualityTimeseriesDetailState("Selected day is no longer in the current range.");
    return;
  }

  const counters =
    selectedBucket.counters && typeof selectedBucket.counters === "object"
      ? selectedBucket.counters
      : {};
  const kernelTrust =
    selectedBucket.kernel_signal_trust &&
    typeof selectedBucket.kernel_signal_trust === "object"
      ? selectedBucket.kernel_signal_trust
      : {};
  const kernelCounters =
    kernelTrust.counters && typeof kernelTrust.counters === "object" ? kernelTrust.counters : {};
  const kernelRates =
    kernelTrust.rates && typeof kernelTrust.rates === "object" ? kernelTrust.rates : {};
  const topRules = Array.isArray(kernelTrust.top_failed_rules) ? kernelTrust.top_failed_rules : [];

  const tags = [
    createStateTag(`day=${selectedBucket.label || "-"}`, "ok"),
    createStateTag(`reviewed=${Number(counters.sessions_reviewed || 0)}`, "ok"),
    createStateTag(
      `kernel_warn=${Number(kernelCounters.validation_warn_events || 0)}`,
      Number(kernelCounters.validation_warn_events || 0) > 0 ? "warn" : "ok"
    ),
    createStateTag(
      `kernel_warn_rate=${formatMetricPercent(kernelRates.validation_warn_rate)}`,
      Number(kernelCounters.validation_warn_events || 0) > 0 ? "warn" : "ok"
    )
  ];
  for (const tag of tags) {
    dom.qualityTimeseriesDetailTags.appendChild(tag);
  }

  if (topRules.length === 0) {
    dom.qualityTimeseriesDetailRules.appendChild(createLi("No failed rules observed in this day."));
  } else {
    for (const rule of topRules) {
      if (!rule || typeof rule.rule !== "string") continue;
      dom.qualityTimeseriesDetailRules.appendChild(
        createLi(`${rule.rule}: ${Number(rule.count || 0)}`)
      );
    }
  }

  setQualityTimeseriesDetailState(
    `Showing ${selectedBucket.label} failed-rule detail (${topRules.length} rules).`
  );
}

function renderDetectionQualityMetrics() {
  dom.qualityMetricsSummary.innerHTML = "";
  const metrics = state.qualityMetrics;
  if (!metrics || typeof metrics !== "object") {
    setQualityMetricsState("Detection quality unavailable.");
    return;
  }

  const counters = metrics.counters && typeof metrics.counters === "object" ? metrics.counters : {};
  const matrix =
    metrics.confusion_matrix && typeof metrics.confusion_matrix === "object"
      ? metrics.confusion_matrix
      : {};
  const rates = metrics.rates && typeof metrics.rates === "object" ? metrics.rates : {};
  const kernelSignalTrust =
    metrics.kernel_signal_trust && typeof metrics.kernel_signal_trust === "object"
      ? metrics.kernel_signal_trust
      : null;
  const kernelCounters =
    kernelSignalTrust &&
    kernelSignalTrust.counters &&
    typeof kernelSignalTrust.counters === "object"
      ? kernelSignalTrust.counters
      : {};
  const kernelRates =
    kernelSignalTrust &&
    kernelSignalTrust.rates &&
    typeof kernelSignalTrust.rates === "object"
      ? kernelSignalTrust.rates
      : {};
  const kernelTopRules =
    kernelSignalTrust && Array.isArray(kernelSignalTrust.top_failed_rules)
      ? kernelSignalTrust.top_failed_rules
      : [];

  const tags = [
    createStateTag(`reviewed=${Number(counters.sessions_reviewed || 0)}`, "ok"),
    createStateTag(`unresolved=${Number(counters.sessions_unresolved || 0)}`, "warn"),
    createStateTag(`TP=${Number(matrix.true_positive || 0)}`, "ok"),
    createStateTag(`FP=${Number(matrix.false_positive || 0)}`, "error"),
    createStateTag(`TN=${Number(matrix.true_negative || 0)}`, "ok"),
    createStateTag(`FN=${Number(matrix.false_negative || 0)}`, "error"),
    createStateTag(`precision=${formatMetricPercent(rates.precision)}`, "ok"),
    createStateTag(`recall=${formatMetricPercent(rates.recall)}`, "ok"),
    createStateTag(`fpr=${formatMetricPercent(rates.false_positive_rate)}`, "warn"),
    createStateTag(`fnr=${formatMetricPercent(rates.false_negative_rate)}`, "warn")
  ];

  if (kernelSignalTrust) {
    const kernelWarnEvents = Number(kernelCounters.validation_warn_events || 0);
    tags.push(createStateTag(`k_total=${Number(kernelCounters.total_kernel_events || 0)}`, "ok"));
    tags.push(
      createStateTag(
        `k_warn=${kernelWarnEvents}`,
        kernelWarnEvents > 0 ? "warn" : "ok"
      )
    );
    tags.push(
      createStateTag(
        `k_warn_rate=${formatMetricPercent(kernelRates.validation_warn_rate)}`,
        kernelWarnEvents > 0 ? "warn" : "ok"
      )
    );
    tags.push(
      createStateTag(
        `k_source_bridge=${Number(kernelCounters.source_kernel_bridge_events || 0)}`,
        "ok"
      )
    );
    tags.push(
      createStateTag(
        `k_source_mismatch=${Number(kernelCounters.source_mismatch_events || 0)}`,
        Number(kernelCounters.source_mismatch_events || 0) > 0 ? "error" : "ok"
      )
    );
    if (kernelTopRules.length > 0) {
      const firstRule = kernelTopRules[0];
      tags.push(createStateTag(`k_top_rule=${firstRule.rule}:${firstRule.count}`, "warn"));
    }
  }

  for (const tag of tags) {
    dom.qualityMetricsSummary.appendChild(tag);
  }
  setQualityMetricsState("");
}

function renderGateFailureCounters() {
  dom.gateFailureCountersTags.innerHTML = "";
  const payload = state.gateFailureCounters;
  if (!payload || typeof payload !== "object") {
    setGateFailureCountersState("Gate failure counters unavailable.");
    return;
  }

  const counters = payload.counters && typeof payload.counters === "object" ? payload.counters : {};
  const day = counters.day && typeof counters.day === "object" ? counters.day : {};
  const week = counters.week && typeof counters.week === "object" ? counters.week : {};
  const contest = counters.contest && typeof counters.contest === "object" ? counters.contest : {};
  const dayTotal = Number(day.total || 0);
  const weekTotal = Number(week.total || 0);
  const contestTotal = Number(contest.total || 0);
  const dayKernel = Number((day.by_reason && day.by_reason.KERNEL_CONNECTION_REQUIRED) || 0);
  const dayClient = Number((day.by_reason && day.by_reason.CLIENT_AGENT_REQUIRED) || 0);
  const weekKernel = Number((week.by_reason && week.by_reason.KERNEL_CONNECTION_REQUIRED) || 0);
  const weekClient = Number((week.by_reason && week.by_reason.CLIENT_AGENT_REQUIRED) || 0);

  const tags = [
    createStateTag(`gate_day=${dayTotal}`, dayTotal > 0 ? "error" : "ok"),
    createStateTag(`gate_week=${weekTotal}`, weekTotal > 0 ? "warn" : "ok"),
    createStateTag(`gate_contest=${contestTotal}`, contestTotal > 0 ? "warn" : "ok"),
    createStateTag(`day_kernel=${dayKernel}`, dayKernel > 0 ? "error" : "ok"),
    createStateTag(`day_client=${dayClient}`, dayClient > 0 ? "error" : "ok"),
    createStateTag(`week_kernel=${weekKernel}`, weekKernel > 0 ? "warn" : "ok"),
    createStateTag(`week_client=${weekClient}`, weekClient > 0 ? "warn" : "ok"),
    createStateTag(`day_sessions=${Number(day.unique_sessions || 0)}`, "ok"),
    createStateTag(`week_sessions=${Number(week.unique_sessions || 0)}`, "ok")
  ];

  for (const tag of tags) {
    dom.gateFailureCountersTags.appendChild(tag);
  }
  setGateFailureCountersState("");
}

function updateSessionsPaginationUi() {
  const page = state.sessionsPage;
  dom.sessionPageInfo.textContent = `offset=${page.offset} limit=${page.limit} total=${page.total}`;
  dom.sessionPrevBtn.disabled = page.offset <= 0;
  dom.sessionNextBtn.disabled = !page.has_more;
}

function setAuthStatus(message) {
  dom.adminAuthStatus.textContent = message;
}

function setBansState(message) {
  dom.bansState.textContent = message;
  dom.bansState.classList.toggle("hidden", message === "");
}

function updateBansPaginationUi() {
  const page = state.bansPage;
  dom.banPageInfo.textContent = `offset=${page.offset} limit=${page.limit} total=${page.total}`;
  dom.banPrevBtn.disabled = page.offset <= 0;
  dom.banNextBtn.disabled = !page.has_more;
}

function setAuditState(message) {
  dom.auditState.textContent = message;
  dom.auditState.classList.toggle("hidden", message === "");
}

function toIsoOrNull(datetimeLocalValue) {
  if (!datetimeLocalValue || datetimeLocalValue.trim() === "") return null;
  const ts = Date.parse(datetimeLocalValue);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString();
}

function updateAuditPaginationUi() {
  const page = state.auditPage;
  dom.auditPageInfo.textContent = `offset=${page.offset} limit=${page.limit} total=${page.total}`;
  dom.auditPrevBtn.disabled = page.offset <= 0;
  dom.auditNextBtn.disabled = !page.has_more;
}

function setNotesState(message) {
  dom.notesState.textContent = message;
  dom.notesState.classList.toggle("hidden", message === "");
}

function updateNotesPaginationUi() {
  const page = state.reviewNotesPage;
  dom.notesPageInfo.textContent = `offset=${page.offset} limit=${page.limit} total=${page.total}`;
  dom.notesPrevBtn.disabled = page.offset <= 0;
  dom.notesNextBtn.disabled = !page.has_more;
}

function setActionsState(message) {
  dom.actionsState.textContent = message;
  dom.actionsState.classList.toggle("hidden", message === "");
}

function updateActionsPaginationUi() {
  const page = state.reviewActionsPage;
  dom.actionsPageInfo.textContent = `offset=${page.offset} limit=${page.limit} total=${page.total}`;
  dom.actionsPrevBtn.disabled = page.offset <= 0;
  dom.actionsNextBtn.disabled = !page.has_more;
}

function setActiveTab(name) {
  state.activeTab = name;
  const isInvestigation = name === "investigation";
  const isBans = name === "bans";
  const isAudit = name === "audit";
  dom.tabInvestigationBtn.classList.toggle("active", isInvestigation);
  dom.tabBansBtn.classList.toggle("active", isBans);
  dom.tabAuditBtn.classList.toggle("active", isAudit);
  dom.viewContent.classList.toggle("active", isInvestigation);
  dom.bansPanel.classList.toggle("active", isBans);
  dom.auditPanel.classList.toggle("active", isAudit);
  dom.viewContent.classList.toggle("hidden", !isInvestigation);
  dom.bansPanel.classList.toggle("hidden", !isBans);
  dom.auditPanel.classList.toggle("hidden", !isAudit);
}

function formatDate(value) {
  if (!value) return "-";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  return new Date(t).toLocaleString();
}

function riskClass(tier) {
  const token = String(tier || "normal").toLowerCase();
  return `risk-${token.replace(/[^a-z0-9]+/g, "-")}`;
}

function createLi(text) {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}

function createStateTag(text, level = "ok") {
  const span = document.createElement("span");
  span.className = `state-tag ${level}`;
  span.textContent = text;
  return span;
}

function getSelectedEventType() {
  if (!state.viewModel || !state.viewModel.evidence_detail) return null;
  const eventType = state.viewModel.evidence_detail.event_type;
  if (!eventType || typeof eventType !== "string") return null;
  return eventType;
}

function getSelectedSeverity() {
  if (!state.viewModel || !state.viewModel.evidence_detail) return null;
  const severity = state.viewModel.evidence_detail.severity;
  if (!severity || typeof severity !== "string") return null;
  return severity;
}

function getSelectedSessionReasonCode() {
  if (!state.selectedSessionId) return "";
  const session = state.sessions.find((item) => item && item.session_id === state.selectedSessionId);
  if (!session || typeof session.decision_reason_code !== "string") return "";
  return session.decision_reason_code;
}

function buildReasonCodeQuickTemplate(reasonCode) {
  if (reasonCode && REASON_CODE_ACTION_TEMPLATES[reasonCode]) {
    return REASON_CODE_ACTION_TEMPLATES[reasonCode];
  }
  return {
    action: "request_follow_up",
    reason:
      "Session requires additional follow-up. Confirm participant environment and collect supplemental evidence.",
    template_code: "follow_up_generic",
    toast_level: "warn"
  };
}

function isLinkedToSelectedEvent(text) {
  const eventType = getSelectedEventType();
  if (!eventType || !text) return false;
  return String(text).toLowerCase().includes(eventType.toLowerCase());
}

function canReview() {
  return state.adminRole === "reviewer" || state.adminRole === "enforcer" || state.adminRole === "admin";
}

function canEnforce() {
  return state.adminRole === "enforcer" || state.adminRole === "admin";
}

function prefillBanTarget() {
  if (!state.selectedSessionId) return;
  const session = state.sessions.find((item) => item.session_id === state.selectedSessionId);
  if (!session) return;
  if (dom.banScope.value === "user") {
    dom.banTargetId.value = session.user_id || "";
  } else if (dom.banScope.value === "session") {
    dom.banTargetId.value = session.session_id || "";
  } else if (dom.banScope.value === "team") {
    dom.banTargetId.value = session.team_id || "";
  }
}

function createKernelPolicyBadge(session) {
  const reasonCode =
    session && typeof session.decision_reason_code === "string"
      ? session.decision_reason_code
      : "";
  if (reasonCode === KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE) {
    return '<span class="session-policy-badge block">kernel:required</span>';
  }
  if (reasonCode === KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE) {
    return '<span class="session-policy-badge block">kernel:rate-low</span>';
  }
  if (reasonCode === KERNEL_INTEGRITY_BLOCK_REASON_CODE) {
    return '<span class="session-policy-badge block">kernel:block</span>';
  }
  if (reasonCode === KERNEL_INTEGRITY_WARN_REASON_CODE) {
    return '<span class="session-policy-badge warn">kernel:warn</span>';
  }
  return "";
}

function createUploadStatusBadge(session) {
  const summary =
    session && typeof session.upload_status_summary === "object"
      ? session.upload_status_summary
      : null;
  if (!summary) return "";
  const status =
    typeof summary.status === "string" ? summary.status.toLowerCase() : "";
  const recoveredBatches = Number(summary.auth_recovered_batches || 0);
  const refreshFailedBatches = Number(summary.auth_refresh_failed_batches || 0);
  if (refreshFailedBatches > 0) {
    return `<span class="session-upload-badge failed">upload:failed(${refreshFailedBatches})</span>`;
  }
  if (status === "recovered" || recoveredBatches > 0) {
    return `<span class="session-upload-badge recovered">upload:recovered${
      recoveredBatches > 0 ? `(${recoveredBatches})` : ""
    }</span>`;
  }
  if (status === "degraded") {
    return '<span class="session-upload-badge degraded">upload:degraded</span>';
  }
  return "";
}

function isKernelPolicyReasonCode(reasonCode) {
  return (
    reasonCode === KERNEL_INTEGRITY_WARN_REASON_CODE ||
    reasonCode === KERNEL_INTEGRITY_BLOCK_REASON_CODE ||
    reasonCode === KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE ||
    reasonCode === KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE
  );
}

function mapSessionPolicyReasonToDecisionCodes(reason, kernelPolicyOnly) {
  if (!kernelPolicyOnly) return [];
  if (reason === "warn") return [KERNEL_INTEGRITY_WARN_REASON_CODE];
  if (reason === "block") {
    return [
      KERNEL_INTEGRITY_BLOCK_REASON_CODE,
      KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE,
      KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE
    ];
  }
  if (reason === "required") {
    return [KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE, KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE];
  }
  return [
    KERNEL_INTEGRITY_WARN_REASON_CODE,
    KERNEL_INTEGRITY_BLOCK_REASON_CODE,
    KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE,
    KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE
  ];
}

function mapParticipantGateDecisionCodes(participantGateOnly) {
  if (!participantGateOnly) return [];
  return [CLIENT_AGENT_REQUIRED_REASON_CODE, KERNEL_CONNECTION_REQUIRED_REASON_CODE];
}

function getVisibleSessions() {
  const filters = readSessionFiltersFromDom();
  let visible = state.sessions;
  if (filters.kernel_policy_only) {
    visible = visible.filter((session) => {
      const reasonCode = session.decision_reason_code;
      if (!isKernelPolicyReasonCode(reasonCode)) return false;
      if (filters.kernel_policy_reason === "warn") {
        return reasonCode === KERNEL_INTEGRITY_WARN_REASON_CODE;
      }
      if (filters.kernel_policy_reason === "block") {
        return (
          reasonCode === KERNEL_INTEGRITY_BLOCK_REASON_CODE ||
          reasonCode === KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE ||
          reasonCode === KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE
        );
      }
      if (filters.kernel_policy_reason === "required") {
        return (
          reasonCode === KERNEL_REQUIRED_SIGNAL_MISSING_REASON_CODE ||
          reasonCode === KERNEL_SIGNAL_RATE_TOO_LOW_REASON_CODE
        );
      }
      return true;
    });
  }
  if (filters.participant_gate_only) {
    visible = visible.filter((session) =>
      isParticipantGateReasonCode(session && session.decision_reason_code)
    );
  }
  return visible;
}

function renderSessions() {
  const currentFilters = readSessionFiltersFromDom();
  const operatorAlerts = summarizeOperatorAlerts(state.sessions);
  updateOperatorAlertBadges(operatorAlerts);
  maybeEmitOperatorAlertToasts(operatorAlerts, currentFilters);
  dom.sessionsList.innerHTML = "";
  updateSessionKernelQuickFilterBadges();
  updateSessionUploadQuickFilterBadges();
  updateSessionsPaginationUi();
  if (state.sessions.length === 0) {
    setSessionsState("No sessions found.");
    return [];
  }
  const visibleSessions = getVisibleSessions();
  if (visibleSessions.length === 0) {
    const msg =
      currentFilters.kernel_policy_only || currentFilters.participant_gate_only
        ? "No sessions match active policy filters."
        : "No sessions found.";
    setSessionsState(msg);
    return [];
  }
  setSessionsState("");
  for (const session of visibleSessions) {
    const kernelBadge = createKernelPolicyBadge(session);
    const uploadBadge = createUploadStatusBadge(session);
    const li = document.createElement("li");
    li.className = `session-item${
      session.session_id === state.selectedSessionId ? " active" : ""
    }`;
    li.innerHTML = `
      <div class="session-title">${session.session_id}</div>
      <div class="session-meta">user: ${session.user_id}</div>
      <div class="session-meta">status: ${session.status} / score: ${session.final_risk_score}${
        kernelBadge ? ` / ${kernelBadge}` : ""
      }${
        uploadBadge ? ` / ${uploadBadge}` : ""
      }</div>
      <div class="session-meta">updated: ${formatDate(session.updated_at)}</div>
    `;
    li.addEventListener("click", () => {
      selectSession(session.session_id);
    });
    dom.sessionsList.appendChild(li);
  }
  return visibleSessions;
}

function applySessionParticipantGateQuickFilter() {
  const current = readSessionFiltersFromDom();
  syncSessionFilters({
    ...current,
    participant_gate_only: !current.participant_gate_only
  });
  state.sessionsPage.offset = 0;
  void loadSessions();
}

function clearSessionSelectionView(message) {
  state.selectedSessionId = null;
  writeSelectedSessionToUrl(null);
  state.selectedEvidenceIndex = null;
  state.viewModel = null;
  setViewState({
    loading: true,
    error: null,
    showContent: false
  });
  dom.viewLoading.textContent = message || "Select a session to load investigation data.";
  void loadReviewNotes();
  void loadReviewActions();
}

function ensureVisibleSessionSelection(visibleSessions) {
  if (!state.selectedSessionId && visibleSessions.length > 0) {
    void selectSession(visibleSessions[0].session_id);
    return;
  }
  if (!state.selectedSessionId) return;
  const found = visibleSessions.some((item) => item.session_id === state.selectedSessionId);
  if (!found) {
    const msg =
      visibleSessions.length === 0
        ? "No visible session for current filters."
        : "Current selected session is hidden by session filters.";
    clearSessionSelectionView(msg);
  }
}

async function loadSessions() {
  if (!state.adminToken) {
    state.sessions = [];
    state.sessionsPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    state.operatorAlertSnapshot = null;
    if (dom.operatorToastHost) {
      dom.operatorToastHost.innerHTML = "";
    }
    state.selectedSessionId = null;
    writeSelectedSessionToUrl(null);
    renderSessions();
    void loadReviewNotes();
    void loadReviewActions();
    void loadGateFailureCounters();
    void loadDetectionQualityMetrics();
    void loadDetectionQualityTimeseries();
    setSessionsState("Login required.");
    return;
  }
  setSessionsState("Loading sessions...");
  const sessionFilters = readSessionFiltersFromDom();
  syncSessionFilters(sessionFilters);
  const status = sessionFilters.status;
  const limit = Number(dom.sessionLimitInput.value || 20);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  state.sessionsPage.limit = safeLimit;
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (sessionFilters.upload_status) {
    query.set("upload_status", sessionFilters.upload_status);
  }
  const decisionReasonCodes = mapSessionPolicyReasonToDecisionCodes(
    sessionFilters.kernel_policy_reason,
    sessionFilters.kernel_policy_only
  );
  const participantGateCodes = mapParticipantGateDecisionCodes(
    sessionFilters.participant_gate_only
  );
  const combinedDecisionCodes = Array.from(
    new Set([...decisionReasonCodes, ...participantGateCodes])
  );
  if (combinedDecisionCodes.length > 0) {
    query.set("decision_reason_code", combinedDecisionCodes.join(","));
  }
  query.set("limit", String(state.sessionsPage.limit));
  query.set("offset", String(state.sessionsPage.offset));
  const path = `/v1/admin/sessions${query.toString() ? `?${query}` : ""}`;
  try {
    const data = await fetchJson(path);
    state.sessions = Array.isArray(data.items) ? data.items : [];
    const page = data.page || {};
    state.sessionsPage = {
      total: Number.isFinite(page.total) ? page.total : state.sessions.length,
      offset: Number.isFinite(page.offset) ? page.offset : state.sessionsPage.offset,
      limit: Number.isFinite(page.limit) ? page.limit : state.sessionsPage.limit,
      has_more: Boolean(page.has_more),
      next_offset: Number.isFinite(page.next_offset) ? page.next_offset : null
    };
    const visibleSessions = renderSessions();
    ensureVisibleSessionSelection(visibleSessions);
    void loadGateFailureCounters();
    void loadDetectionQualityMetrics();
    void loadDetectionQualityTimeseries();
  } catch (error) {
    setSessionsState(`Failed to load sessions: ${error.message}`);
    state.gateFailureCounters = null;
    dom.gateFailureCountersTags.innerHTML = "";
    setGateFailureCountersState(`Failed to load gate counters: ${error.message}`);
    state.qualityMetrics = null;
    dom.qualityMetricsSummary.innerHTML = "";
    setQualityMetricsState(`Failed to load metrics: ${error.message}`);
    state.qualityTimeseries = null;
    dom.qualityTimeseriesBody.innerHTML = "";
    dom.qualityTimeseriesEmpty.classList.remove("hidden");
    resetQualityTimeseriesDetail(`Trend detail unavailable: ${error.message}`);
    setQualityTimeseriesState(`Failed to load trend: ${error.message}`);
  }
}

async function loadRuntimeConfig() {
  if (!state.adminToken) {
    state.runtimeConfig = null;
    syncRuntimePolicyControlsFromConfig();
    return;
  }
  try {
    const config = await fetchJson("/v1/admin/runtime-config");
    state.runtimeConfig = config && typeof config === "object" ? config : null;
    syncRuntimePolicyControlsFromConfig();
  } catch (error) {
    state.runtimeConfig = null;
    syncRuntimePolicyControlsFromConfig();
    setRuntimePolicyControlState(`Failed to load runtime config: ${error.message}`);
  }
}

function syncRuntimePolicyControlsFromConfig() {
  const runtimeConfig =
    state.runtimeConfig && typeof state.runtimeConfig === "object" ? state.runtimeConfig : null;
  const integrationApi =
    runtimeConfig &&
    runtimeConfig.integration_api &&
    typeof runtimeConfig.integration_api === "object"
      ? runtimeConfig.integration_api
      : null;
  const llmMonitor =
    runtimeConfig &&
    runtimeConfig.llm_monitor &&
    typeof runtimeConfig.llm_monitor === "object"
      ? runtimeConfig.llm_monitor
      : null;

  if (!runtimeConfig) {
    dom.policyRequireDiscordLinkedToggle.checked = false;
    dom.policyRequireDiscordLinkedActionSelect.value = "blocked";
    dom.policyRequireDiscordLinkedGraceSecInput.value = "0";
    dom.policyCliDetectionActionSelect.value = "off";
    dom.policyCliConfidenceThresholdInput.value = "85";
    dom.policyCliMinEvidenceCountInput.value = "1";
    dom.policyCliEnforcementCooldownSecInput.value = "0";
    dom.policyCliOverrideWindowSecInput.value = "0";
    dom.runtimePolicyHighImpactConfirmCheckbox.checked = false;
    dom.saveRuntimePolicyBtn.disabled = true;
    dom.reloadRuntimePolicyBtn.disabled = true;
    setRuntimePolicyControlState("Login required.");
    return;
  }

  dom.policyRequireDiscordLinkedToggle.checked = integrationApi
    ? integrationApi.discord_require_linked === true
    : false;
  const requireLinkedAction = integrationApi &&
    typeof integrationApi.discord_require_linked_action === "string"
    ? integrationApi.discord_require_linked_action
    : "blocked";
  if (!["warn", "restricted", "blocked"].includes(requireLinkedAction)) {
    dom.policyRequireDiscordLinkedActionSelect.value = "blocked";
  } else {
    dom.policyRequireDiscordLinkedActionSelect.value = requireLinkedAction;
  }
  const requireLinkedGraceSec = integrationApi &&
    Number.isFinite(integrationApi.discord_require_linked_grace_sec)
    ? integrationApi.discord_require_linked_grace_sec
    : 0;
  dom.policyRequireDiscordLinkedGraceSecInput.value = String(
    Math.max(0, Math.floor(requireLinkedGraceSec))
  );
  const cliAction = llmMonitor && typeof llmMonitor.cli_detection_action === "string"
    ? llmMonitor.cli_detection_action
    : "warn";
  if (!["off", "warn", "restricted", "blocked"].includes(cliAction)) {
    dom.policyCliDetectionActionSelect.value = "warn";
  } else {
    dom.policyCliDetectionActionSelect.value = cliAction;
  }
  const cliThreshold = llmMonitor && Number.isFinite(llmMonitor.cli_confidence_threshold)
    ? llmMonitor.cli_confidence_threshold
    : 85;
  dom.policyCliConfidenceThresholdInput.value = String(Math.max(0, Math.min(100, cliThreshold)));
  const cliMinEvidenceCount = llmMonitor && Number.isFinite(llmMonitor.cli_min_evidence_count)
    ? llmMonitor.cli_min_evidence_count
    : 1;
  dom.policyCliMinEvidenceCountInput.value = String(Math.max(1, Math.floor(cliMinEvidenceCount)));
  const cliCooldownSec = llmMonitor && Number.isFinite(llmMonitor.cli_enforcement_cooldown_sec)
    ? llmMonitor.cli_enforcement_cooldown_sec
    : 0;
  dom.policyCliEnforcementCooldownSecInput.value = String(Math.max(0, Math.floor(cliCooldownSec)));
  const cliOverrideWindowSec = llmMonitor && Number.isFinite(llmMonitor.cli_override_window_sec)
    ? llmMonitor.cli_override_window_sec
    : 0;
  dom.policyCliOverrideWindowSecInput.value = String(Math.max(0, Math.floor(cliOverrideWindowSec)));
  dom.runtimePolicyHighImpactConfirmCheckbox.checked = false;
  dom.saveRuntimePolicyBtn.disabled = !canEnforce();
  dom.reloadRuntimePolicyBtn.disabled = false;
  setRuntimePolicyControlState("Runtime policy loaded.");
}

function normalizeCliThresholdInput(rawValue, fallback = 85) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return Math.floor(parsed);
}

function normalizeNonNegativeIntegerInput(rawValue, fallback = 0) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizePositiveIntegerInput(rawValue, fallback = 1) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function buildRuntimePolicyPatchPayload() {
  const runtimeConfig =
    state.runtimeConfig && typeof state.runtimeConfig === "object" ? state.runtimeConfig : null;
  const integrationApi =
    runtimeConfig &&
    runtimeConfig.integration_api &&
    typeof runtimeConfig.integration_api === "object"
      ? runtimeConfig.integration_api
      : null;
  const llmMonitor =
    runtimeConfig &&
    runtimeConfig.llm_monitor &&
    typeof runtimeConfig.llm_monitor === "object"
      ? runtimeConfig.llm_monitor
      : null;
  if (!runtimeConfig) return null;

  const previousRequireDiscordLinked = integrationApi
    ? integrationApi.discord_require_linked === true
    : false;
  const nextRequireDiscordLinked = dom.policyRequireDiscordLinkedToggle.checked === true;
  const previousRequireDiscordLinkedAction =
    integrationApi && typeof integrationApi.discord_require_linked_action === "string"
      ? integrationApi.discord_require_linked_action
      : "blocked";
  const nextRequireDiscordLinkedAction = String(
    dom.policyRequireDiscordLinkedActionSelect.value || "blocked"
  )
    .trim()
    .toLowerCase();
  const previousRequireDiscordLinkedGraceSec =
    integrationApi && Number.isFinite(integrationApi.discord_require_linked_grace_sec)
      ? integrationApi.discord_require_linked_grace_sec
      : 0;
  const nextRequireDiscordLinkedGraceSec = normalizeNonNegativeIntegerInput(
    dom.policyRequireDiscordLinkedGraceSecInput.value,
    previousRequireDiscordLinkedGraceSec
  );
  dom.policyRequireDiscordLinkedGraceSecInput.value = String(nextRequireDiscordLinkedGraceSec);
  const previousCliAction =
    llmMonitor && typeof llmMonitor.cli_detection_action === "string"
      ? llmMonitor.cli_detection_action
      : "warn";
  const nextCliAction = String(dom.policyCliDetectionActionSelect.value || "warn")
    .trim()
    .toLowerCase();
  const previousCliThreshold =
    llmMonitor && Number.isFinite(llmMonitor.cli_confidence_threshold)
      ? llmMonitor.cli_confidence_threshold
      : 85;
  const nextCliThreshold = normalizeCliThresholdInput(dom.policyCliConfidenceThresholdInput.value, previousCliThreshold);
  dom.policyCliConfidenceThresholdInput.value = String(nextCliThreshold);
  const previousCliMinEvidenceCount =
    llmMonitor && Number.isFinite(llmMonitor.cli_min_evidence_count)
      ? llmMonitor.cli_min_evidence_count
      : 1;
  const nextCliMinEvidenceCount = normalizePositiveIntegerInput(
    dom.policyCliMinEvidenceCountInput.value,
    previousCliMinEvidenceCount
  );
  dom.policyCliMinEvidenceCountInput.value = String(nextCliMinEvidenceCount);
  const previousCliEnforcementCooldownSec =
    llmMonitor && Number.isFinite(llmMonitor.cli_enforcement_cooldown_sec)
      ? llmMonitor.cli_enforcement_cooldown_sec
      : 0;
  const nextCliEnforcementCooldownSec = normalizeNonNegativeIntegerInput(
    dom.policyCliEnforcementCooldownSecInput.value,
    previousCliEnforcementCooldownSec
  );
  dom.policyCliEnforcementCooldownSecInput.value = String(nextCliEnforcementCooldownSec);
  const previousCliOverrideWindowSec =
    llmMonitor && Number.isFinite(llmMonitor.cli_override_window_sec)
      ? llmMonitor.cli_override_window_sec
      : 0;
  const nextCliOverrideWindowSec = normalizeNonNegativeIntegerInput(
    dom.policyCliOverrideWindowSecInput.value,
    previousCliOverrideWindowSec
  );
  dom.policyCliOverrideWindowSecInput.value = String(nextCliOverrideWindowSec);

  const participantGatePatch = {};
  const llmMonitorPatch = {};
  const changedFields = [];
  if (previousRequireDiscordLinked !== nextRequireDiscordLinked) {
    participantGatePatch.require_discord_linked = nextRequireDiscordLinked;
    changedFields.push("require_discord_linked");
  }
  if (previousRequireDiscordLinkedAction !== nextRequireDiscordLinkedAction) {
    participantGatePatch.require_discord_linked_action = nextRequireDiscordLinkedAction;
    changedFields.push("require_discord_linked_action");
  }
  if (previousRequireDiscordLinkedGraceSec !== nextRequireDiscordLinkedGraceSec) {
    participantGatePatch.require_discord_linked_grace_sec = nextRequireDiscordLinkedGraceSec;
    changedFields.push("require_discord_linked_grace_sec");
  }
  if (previousCliAction !== nextCliAction) {
    llmMonitorPatch.cli_detection_action = nextCliAction;
    changedFields.push("cli_detection_action");
  }
  if (previousCliThreshold !== nextCliThreshold) {
    llmMonitorPatch.cli_confidence_threshold = nextCliThreshold;
    changedFields.push("cli_confidence_threshold");
  }
  if (previousCliMinEvidenceCount !== nextCliMinEvidenceCount) {
    llmMonitorPatch.cli_min_evidence_count = nextCliMinEvidenceCount;
    changedFields.push("cli_min_evidence_count");
  }
  if (previousCliEnforcementCooldownSec !== nextCliEnforcementCooldownSec) {
    llmMonitorPatch.cli_enforcement_cooldown_sec = nextCliEnforcementCooldownSec;
    changedFields.push("cli_enforcement_cooldown_sec");
  }
  if (previousCliOverrideWindowSec !== nextCliOverrideWindowSec) {
    llmMonitorPatch.cli_override_window_sec = nextCliOverrideWindowSec;
    changedFields.push("cli_override_window_sec");
  }
  if (changedFields.length === 0) {
    return {
      changed_fields: [],
      payload: null
    };
  }
  const payload = {};
  if (Object.keys(participantGatePatch).length > 0) {
    payload.participant_gate = participantGatePatch;
  }
  if (Object.keys(llmMonitorPatch).length > 0) {
    payload.llm_monitor = llmMonitorPatch;
  }
  return {
    changed_fields: changedFields,
    payload
  };
}

function buildRuntimePolicyConfirmationMessage(changedFields, reason) {
  const lines = [];
  lines.push("Apply runtime policy update?");
  lines.push(`Changed fields: ${changedFields.join(", ")}`);
  lines.push(`Reason: ${String(reason || "").trim().slice(0, 240)}`);
  lines.push("");
  lines.push("This can immediately affect participant eligibility.");
  return lines.join("\n");
}

async function saveRuntimePolicy() {
  if (!canEnforce()) {
    setRuntimePolicyControlState("Current role cannot update runtime policy.");
    return;
  }
  const patch = buildRuntimePolicyPatchPayload();
  if (!patch || !patch.payload || patch.changed_fields.length === 0) {
    setRuntimePolicyControlState("No runtime policy changes detected.");
    return;
  }
  const hasSensitiveField = patch.changed_fields.some((field) =>
    RUNTIME_POLICY_SENSITIVE_FIELDS.has(field)
  );
  const reason = String(dom.runtimePolicyUpdateReasonInput.value || "").trim();
  if (hasSensitiveField && reason.length < 12) {
    setRuntimePolicyControlState("Provide an evidence-based reason (minimum 12 characters).");
    return;
  }
  if (hasSensitiveField && dom.runtimePolicyHighImpactConfirmCheckbox.checked !== true) {
    setRuntimePolicyControlState(
      "Check high_impact_confirmed before applying sensitive runtime policy changes."
    );
    return;
  }
  if (
    hasSensitiveField &&
    typeof window !== "undefined" &&
    typeof window.confirm === "function" &&
    !window.confirm(buildRuntimePolicyConfirmationMessage(patch.changed_fields, reason))
  ) {
    setRuntimePolicyControlState("Runtime policy update cancelled.");
    return;
  }
  try {
    setRuntimePolicyControlState("Applying runtime policy update...");
    const response = await fetchJson("/v1/admin/runtime-config/policy", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...patch.payload,
        reason,
        high_impact_confirmed: hasSensitiveField
          ? dom.runtimePolicyHighImpactConfirmCheckbox.checked === true
          : false
      })
    });
    if (response && response.runtime_config && typeof response.runtime_config === "object") {
      state.runtimeConfig = response.runtime_config;
      syncRuntimePolicyControlsFromConfig();
    } else {
      await loadRuntimeConfig();
    }
    setRuntimePolicyControlState(
      `Runtime policy updated (${patch.changed_fields.join(", ")}).`
    );
    dom.runtimePolicyUpdateReasonInput.value = "";
    dom.runtimePolicyHighImpactConfirmCheckbox.checked = false;
    await loadSessions();
  } catch (error) {
    setRuntimePolicyControlState(`Failed to update runtime policy: ${error.message}`);
  }
}

async function loadGateFailureCounters() {
  if (!state.adminToken) {
    state.gateFailureCounters = null;
    dom.gateFailureCountersTags.innerHTML = "";
    setGateFailureCountersState("Login required.");
    return;
  }

  setGateFailureCountersState("Loading gate failure counters...");
  try {
    const payload = await fetchJson("/v1/admin/metrics/gate-failures");
    state.gateFailureCounters = payload && typeof payload === "object" ? payload : null;
    renderGateFailureCounters();
  } catch (error) {
    state.gateFailureCounters = null;
    dom.gateFailureCountersTags.innerHTML = "";
    setGateFailureCountersState(`Failed to load gate counters: ${error.message}`);
  }
}

async function loadDetectionQualityMetrics() {
  if (!state.adminToken) {
    state.qualityMetrics = null;
    setQualityMetricsState("Login required.");
    dom.qualityMetricsSummary.innerHTML = "";
    return;
  }

  setQualityMetricsState("Loading detection quality metrics...");
  try {
    const payload = await fetchJson("/v1/admin/metrics/detection-quality?sample_limit=5");
    state.qualityMetrics = payload && typeof payload === "object" ? payload : null;
    renderDetectionQualityMetrics();
  } catch (error) {
    state.qualityMetrics = null;
    dom.qualityMetricsSummary.innerHTML = "";
    setQualityMetricsState(`Failed to load metrics: ${error.message}`);
  }
}

async function loadDetectionQualityTimeseries() {
  if (!state.adminToken) {
    state.qualityTimeseries = null;
    dom.qualityTimeseriesBody.innerHTML = "";
    dom.qualityTimeseriesEmpty.classList.remove("hidden");
    resetQualityTimeseriesDetail("Login required to inspect trend details.");
    setQualityTimeseriesState("Login required.");
    return;
  }

  const fromIso = toIsoOrNull(dom.qualityTimeseriesFromInput.value);
  const toIso = toIsoOrNull(dom.qualityTimeseriesToInput.value);
  if (fromIso && toIso && Date.parse(fromIso) > Date.parse(toIso)) {
    state.qualityTimeseries = null;
    dom.qualityTimeseriesBody.innerHTML = "";
    dom.qualityTimeseriesEmpty.classList.remove("hidden");
    resetQualityTimeseriesDetail("Fix range first to inspect failed-rule details.");
    setQualityTimeseriesState("Invalid range: 'from' must be earlier than 'to'.");
    return;
  }

  const rawBuckets = Number(dom.qualityTimeseriesBucketsInput.value || 30);
  const maxBuckets = Number.isFinite(rawBuckets)
    ? Math.max(1, Math.min(365, Math.floor(rawBuckets)))
    : 30;
  dom.qualityTimeseriesBucketsInput.value = String(maxBuckets);

  const params = new URLSearchParams();
  if (fromIso) params.set("from", fromIso);
  if (toIso) params.set("to", toIso);
  params.set("max_buckets", String(maxBuckets));

  setQualityTimeseriesState("Loading detection quality trend...");
  try {
    const payload = await fetchJson(
      `/v1/admin/metrics/detection-quality/timeseries?${params.toString()}`
    );
    state.qualityTimeseries = payload && typeof payload === "object" ? payload : null;
    renderDetectionQualityTimeseries();
  } catch (error) {
    state.qualityTimeseries = null;
    dom.qualityTimeseriesBody.innerHTML = "";
    dom.qualityTimeseriesEmpty.classList.remove("hidden");
    resetQualityTimeseriesDetail(`Trend detail unavailable: ${error.message}`);
    setQualityTimeseriesState(`Failed to load trend: ${error.message}`);
  }
}

function renderSummary(vm) {
  const summary = vm.session_summary || {};
  const runtimeKernelIntegrity =
    state.runtimeConfig &&
    typeof state.runtimeConfig === "object" &&
    state.runtimeConfig.kernel_integrity &&
    typeof state.runtimeConfig.kernel_integrity === "object"
      ? state.runtimeConfig.kernel_integrity
      : null;
  const kernelWarnAction =
    runtimeKernelIntegrity && typeof runtimeKernelIntegrity.warn_action === "string"
      ? runtimeKernelIntegrity.warn_action
      : "unknown";
  const kernelRequireSignals =
    runtimeKernelIntegrity && typeof runtimeKernelIntegrity.require_signals === "boolean"
      ? runtimeKernelIntegrity.require_signals
      : null;
  const kernelMinSignals =
    runtimeKernelIntegrity &&
    Number.isFinite(runtimeKernelIntegrity.min_kernel_signals_per_batch)
      ? runtimeKernelIntegrity.min_kernel_signals_per_batch
      : null;
  const kernelSignalRateWindowSec =
    runtimeKernelIntegrity && Number.isFinite(runtimeKernelIntegrity.signal_rate_window_sec)
      ? runtimeKernelIntegrity.signal_rate_window_sec
      : null;
  const kernelMinSignalsPerMinute =
    runtimeKernelIntegrity && Number.isFinite(runtimeKernelIntegrity.min_kernel_signals_per_minute)
      ? runtimeKernelIntegrity.min_kernel_signals_per_minute
      : null;
  const kernelRequireBridgeSignature =
    runtimeKernelIntegrity && typeof runtimeKernelIntegrity.require_bridge_signature === "boolean"
      ? runtimeKernelIntegrity.require_bridge_signature
      : null;
  const kernelRequireBridgeNonce =
    runtimeKernelIntegrity && typeof runtimeKernelIntegrity.require_bridge_nonce === "boolean"
      ? runtimeKernelIntegrity.require_bridge_nonce
      : null;
  const kernelRequireBridgeEmittedAt =
    runtimeKernelIntegrity && typeof runtimeKernelIntegrity.require_bridge_emitted_at === "boolean"
      ? runtimeKernelIntegrity.require_bridge_emitted_at
      : null;
  const kernelMaxBridgeCounterGap =
    runtimeKernelIntegrity && Number.isFinite(runtimeKernelIntegrity.max_bridge_counter_gap)
      ? runtimeKernelIntegrity.max_bridge_counter_gap
      : null;
  const kernelMaxBridgeStalenessMs =
    runtimeKernelIntegrity && Number.isFinite(runtimeKernelIntegrity.max_bridge_staleness_ms)
      ? runtimeKernelIntegrity.max_bridge_staleness_ms
      : null;
  const kernelBridgeSignatureVerificationEnabled =
    runtimeKernelIntegrity &&
    typeof runtimeKernelIntegrity.bridge_signature_verification_enabled === "boolean"
      ? runtimeKernelIntegrity.bridge_signature_verification_enabled
      : null;
  const kernelRequireSessionBindingToken =
    runtimeKernelIntegrity &&
    typeof runtimeKernelIntegrity.require_session_binding_token === "boolean"
      ? runtimeKernelIntegrity.require_session_binding_token
      : null;
  const kernelSessionBindingVerificationEnabled =
    runtimeKernelIntegrity &&
    typeof runtimeKernelIntegrity.session_binding_verification_enabled === "boolean"
      ? runtimeKernelIntegrity.session_binding_verification_enabled
      : null;
  const kernelBindingTokenTtlSec =
    runtimeKernelIntegrity && Number.isFinite(runtimeKernelIntegrity.kernel_binding_token_ttl_sec)
      ? runtimeKernelIntegrity.kernel_binding_token_ttl_sec
      : null;
  const fields = [
    ["session_id", summary.session_id],
    ["user_id", summary.user_id],
    ["client_version", summary.client_version],
    ["client_agent_state", summary.client_agent_state || "unknown"],
    ["kernel_bridge_state", summary.kernel_bridge_state || "unknown"],
    ["kernel_driver_loaded", summary.kernel_driver_loaded === true],
    [
      "participant_gate",
      summary.participant_gate_result
        ? summary.participant_gate_result.ok
          ? "ok"
          : summary.participant_gate_result.code || "blocked"
        : "unknown"
    ],
    ["session_start_time", formatDate(summary.session_start_time)],
    ["session_end_time", formatDate(summary.session_end_time)],
    ["current_status", summary.current_status],
    ["final_risk_score", summary.final_risk_score],
    ["risk_tier", summary.risk_tier],
    ["kernel_warn_action", kernelWarnAction],
    ["kernel_require_signals", kernelRequireSignals === null ? "unknown" : kernelRequireSignals],
    ["kernel_min_signals_per_batch", kernelMinSignals === null ? "unknown" : kernelMinSignals],
    [
      "kernel_signal_rate_window_sec",
      kernelSignalRateWindowSec === null ? "unknown" : kernelSignalRateWindowSec
    ],
    [
      "kernel_min_signals_per_minute",
      kernelMinSignalsPerMinute === null ? "unknown" : kernelMinSignalsPerMinute
    ],
    [
      "kernel_require_bridge_signature",
      kernelRequireBridgeSignature === null ? "unknown" : kernelRequireBridgeSignature
    ],
    [
      "kernel_require_bridge_nonce",
      kernelRequireBridgeNonce === null ? "unknown" : kernelRequireBridgeNonce
    ],
    [
      "kernel_require_bridge_emitted_at",
      kernelRequireBridgeEmittedAt === null ? "unknown" : kernelRequireBridgeEmittedAt
    ],
    [
      "kernel_max_bridge_counter_gap",
      kernelMaxBridgeCounterGap === null ? "unknown" : kernelMaxBridgeCounterGap
    ],
    [
      "kernel_max_bridge_staleness_ms",
      kernelMaxBridgeStalenessMs === null ? "unknown" : kernelMaxBridgeStalenessMs
    ],
    [
      "kernel_bridge_signature_verification_enabled",
      kernelBridgeSignatureVerificationEnabled === null
        ? "unknown"
        : kernelBridgeSignatureVerificationEnabled
    ],
    [
      "kernel_require_session_binding_token",
      kernelRequireSessionBindingToken === null ? "unknown" : kernelRequireSessionBindingToken
    ],
    [
      "kernel_session_binding_verification_enabled",
      kernelSessionBindingVerificationEnabled === null
        ? "unknown"
        : kernelSessionBindingVerificationEnabled
    ],
    [
      "kernel_binding_token_ttl_sec",
      kernelBindingTokenTtlSec === null ? "unknown" : kernelBindingTokenTtlSec
    ],
    [
      "version_policy_result",
      summary.version_policy_result ? summary.version_policy_result.status : "unknown"
    ]
  ];
  dom.sessionSummary.innerHTML = "";
  for (const [name, value] of fields) {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value === null || value === undefined ? "-" : String(value);
    dom.sessionSummary.appendChild(dt);
    dom.sessionSummary.appendChild(dd);
  }
}

function renderRisk(vm) {
  const risk = vm.risk_overview || {};
  const contributors = Array.isArray(risk.major_contributing_events)
    ? risk.major_contributing_events
    : [];
  const lines = [
    `Total Score: ${risk.total_score || 0}`,
    `Rejected Events: ${risk.rejected_event_count || 0}`
  ];
  dom.riskOverview.innerHTML = "";
  const tier = document.createElement("span");
  tier.className = `risk-tag ${riskClass(risk.score_tier)}`;
  tier.textContent = `Tier: ${risk.score_tier || "normal"}`;
  dom.riskOverview.appendChild(tier);
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    dom.riskOverview.appendChild(div);
  }
  const title = document.createElement("div");
  title.textContent = "Major Contributors:";
  dom.riskOverview.appendChild(title);
  const ul = document.createElement("ul");
  if (contributors.length === 0) {
    ul.appendChild(createLi("None"));
  } else {
    for (const item of contributors) {
      ul.appendChild(
        createLi(`${item.event_type} (${item.severity}) +${item.score_delta} @ ${formatDate(item.timestamp)}`)
      );
    }
  }
  dom.riskOverview.appendChild(ul);
}

function renderInvestigationStates(vm) {
  dom.investigationStates.innerHTML = "";
  dom.runtimePolicyState.innerHTML = "";
  const states = vm && vm.states && typeof vm.states === "object" ? vm.states : {};
  const tags = [];

  if (states.session_not_found) {
    tags.push(createStateTag("Session not found", "error"));
  }
  if (states.scoring_unavailable) {
    tags.push(createStateTag("Scoring unavailable", "error"));
  }
  if (states.no_events_available) {
    tags.push(createStateTag("No events available", "warn"));
  }
  if (states.partial_evidence_available) {
    tags.push(createStateTag("Partial evidence detected", "warn"));
  }
  if (states.noisy_events_collapsed) {
    tags.push(createStateTag("Noisy events collapsed", "ok"));
  }
  if (states.validation_warn_only) {
    tags.push(createStateTag("Validation warn filter active", "warn"));
  }
  if (typeof states.validation_failed_rule === "string" && states.validation_failed_rule) {
    tags.push(createStateTag(`Rule filter: ${states.validation_failed_rule}`, "warn"));
  }
  if (states.llm_domain_only) {
    tags.push(createStateTag("LLM domain filter active", "warn"));
  }

  if (tags.length === 0) {
    tags.push(createStateTag("All core investigation signals available", "ok"));
  }

  for (const tag of tags) {
    dom.investigationStates.appendChild(tag);
  }

  const kernelIntegrity =
    state.runtimeConfig &&
    typeof state.runtimeConfig === "object" &&
    state.runtimeConfig.kernel_integrity &&
    typeof state.runtimeConfig.kernel_integrity === "object"
      ? state.runtimeConfig.kernel_integrity
      : null;
  if (!kernelIntegrity) {
    dom.runtimePolicyState.appendChild(createStateTag("Kernel policy: unavailable", "warn"));
    return;
  }

  const warnAction =
    typeof kernelIntegrity.warn_action === "string" ? kernelIntegrity.warn_action : "unknown";
  const requireSignals =
    typeof kernelIntegrity.require_signals === "boolean"
      ? kernelIntegrity.require_signals
      : null;
  const minKernelSignals =
    Number.isFinite(kernelIntegrity.min_kernel_signals_per_batch)
      ? kernelIntegrity.min_kernel_signals_per_batch
      : "?";
  const signalRateWindowSec =
    Number.isFinite(kernelIntegrity.signal_rate_window_sec)
      ? kernelIntegrity.signal_rate_window_sec
      : "?";
  const minKernelSignalsPerMinute =
    Number.isFinite(kernelIntegrity.min_kernel_signals_per_minute)
      ? kernelIntegrity.min_kernel_signals_per_minute
      : "?";
  const maxSignals =
    Number.isFinite(kernelIntegrity.max_kernel_signals_per_batch)
      ? kernelIntegrity.max_kernel_signals_per_batch
      : "?";
  const maxEmitDelta =
    Number.isFinite(kernelIntegrity.max_bridge_emit_delta_ms)
      ? kernelIntegrity.max_bridge_emit_delta_ms
      : "?";
  const maxBridgeCounterGap =
    Number.isFinite(kernelIntegrity.max_bridge_counter_gap)
      ? kernelIntegrity.max_bridge_counter_gap
      : "?";
  const maxBridgeStalenessMs =
    Number.isFinite(kernelIntegrity.max_bridge_staleness_ms)
      ? kernelIntegrity.max_bridge_staleness_ms
      : "?";
  const requireBridgeSignature =
    typeof kernelIntegrity.require_bridge_signature === "boolean"
      ? kernelIntegrity.require_bridge_signature
      : null;
  const requireBridgeNonce =
    typeof kernelIntegrity.require_bridge_nonce === "boolean"
      ? kernelIntegrity.require_bridge_nonce
      : null;
  const requireBridgeEmittedAt =
    typeof kernelIntegrity.require_bridge_emitted_at === "boolean"
      ? kernelIntegrity.require_bridge_emitted_at
      : null;
  const bridgeSignatureVerificationEnabled =
    typeof kernelIntegrity.bridge_signature_verification_enabled === "boolean"
      ? kernelIntegrity.bridge_signature_verification_enabled
      : null;
  const requireSessionBindingToken =
    typeof kernelIntegrity.require_session_binding_token === "boolean"
      ? kernelIntegrity.require_session_binding_token
      : null;
  const sessionBindingVerificationEnabled =
    typeof kernelIntegrity.session_binding_verification_enabled === "boolean"
      ? kernelIntegrity.session_binding_verification_enabled
      : null;
  const kernelBindingTokenTtlSec =
    Number.isFinite(kernelIntegrity.kernel_binding_token_ttl_sec)
      ? kernelIntegrity.kernel_binding_token_ttl_sec
      : "?";
  const warnLevel = warnAction === "block" ? "error" : warnAction === "warn" ? "warn" : "ok";
  dom.runtimePolicyState.appendChild(
    createStateTag(`Kernel policy warn_action=${warnAction}`, warnLevel)
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(
      `Kernel policy require_signals=${requireSignals === null ? "unknown" : requireSignals}`,
      requireSignals === true ? "ok" : "warn"
    )
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(`min_kernel_signals_per_batch=${minKernelSignals}`, "ok")
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(`signal_rate_window_sec=${signalRateWindowSec}`, "ok")
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(`min_kernel_signals_per_minute=${minKernelSignalsPerMinute}`, "ok")
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(`max_signals_per_batch=${maxSignals}`, "ok")
  );
  dom.runtimePolicyState.appendChild(createStateTag(`max_emit_delta_ms=${maxEmitDelta}`, "ok"));
  dom.runtimePolicyState.appendChild(
    createStateTag(`max_bridge_counter_gap=${maxBridgeCounterGap}`, "ok")
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(`max_bridge_staleness_ms=${maxBridgeStalenessMs}`, "ok")
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(
      `require_bridge_signature=${requireBridgeSignature === null ? "unknown" : requireBridgeSignature}`,
      requireBridgeSignature === true ? "ok" : "warn"
    )
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(
      `require_bridge_nonce=${requireBridgeNonce === null ? "unknown" : requireBridgeNonce}`,
      requireBridgeNonce === true ? "ok" : "warn"
    )
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(
      `require_bridge_emitted_at=${requireBridgeEmittedAt === null ? "unknown" : requireBridgeEmittedAt}`,
      requireBridgeEmittedAt === true ? "ok" : "warn"
    )
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(
      `bridge_signature_verification_enabled=${bridgeSignatureVerificationEnabled === null ? "unknown" : bridgeSignatureVerificationEnabled}`,
      bridgeSignatureVerificationEnabled === true ? "ok" : "warn"
    )
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(
      `require_session_binding_token=${requireSessionBindingToken === null ? "unknown" : requireSessionBindingToken}`,
      requireSessionBindingToken === true ? "ok" : "warn"
    )
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(
      `session_binding_verification_enabled=${sessionBindingVerificationEnabled === null ? "unknown" : sessionBindingVerificationEnabled}`,
      sessionBindingVerificationEnabled === true ? "ok" : "warn"
    )
  );
  dom.runtimePolicyState.appendChild(
    createStateTag(`kernel_binding_token_ttl_sec=${kernelBindingTokenTtlSec}`, "ok")
  );

  const participantGate =
    state.runtimeConfig &&
    typeof state.runtimeConfig === "object" &&
    state.runtimeConfig.participant_gate &&
    typeof state.runtimeConfig.participant_gate === "object"
      ? state.runtimeConfig.participant_gate
      : null;
  if (participantGate) {
    dom.runtimePolicyState.appendChild(
      createStateTag(
        `participant_gate.client_agent_running=${participantGate.require_client_agent_running === true}`,
        participantGate.require_client_agent_running === true ? "ok" : "warn"
      )
    );
    dom.runtimePolicyState.appendChild(
      createStateTag(
        `participant_gate.kernel_connected=${participantGate.require_kernel_connected === true}`,
        participantGate.require_kernel_connected === true ? "ok" : "warn"
      )
    );
  }

  const integrationApi =
    state.runtimeConfig &&
    typeof state.runtimeConfig === "object" &&
    state.runtimeConfig.integration_api &&
    typeof state.runtimeConfig.integration_api === "object"
      ? state.runtimeConfig.integration_api
      : null;
  if (integrationApi) {
    const unavailablePolicy =
      typeof integrationApi.discord_client_unavailable_policy === "string"
        ? integrationApi.discord_client_unavailable_policy
        : "unknown";
    const lossPolicy =
      typeof integrationApi.discord_identity_loss_policy === "string"
        ? integrationApi.discord_identity_loss_policy
        : "unknown";
    const unavailableGrace =
      Number.isFinite(integrationApi.discord_client_unavailable_grace_sec)
        ? integrationApi.discord_client_unavailable_grace_sec
        : "?";
    const lossGrace =
      Number.isFinite(integrationApi.discord_identity_loss_grace_sec)
        ? integrationApi.discord_identity_loss_grace_sec
        : "?";
    const revokeTargetConfigured =
      integrationApi.discord_role_revoke_guild_id_configured === true &&
      integrationApi.discord_role_revoke_role_id_configured === true;
    const toneForPolicy = (value) => {
      if (value === "blocked") return "error";
      if (value === "restricted") return "warn";
      if (value === "warn") return "ok";
      return "warn";
    };
    dom.runtimePolicyState.appendChild(
      createStateTag(
        `discord_identity_loss_policy=${lossPolicy} (grace=${lossGrace}s)`,
        toneForPolicy(lossPolicy)
      )
    );
    dom.runtimePolicyState.appendChild(
      createStateTag(
        `discord_client_unavailable_policy=${unavailablePolicy} (grace=${unavailableGrace}s)`,
        toneForPolicy(unavailablePolicy)
      )
    );
    dom.runtimePolicyState.appendChild(
      createStateTag(
        `discord_role_revoke_target_configured=${revokeTargetConfigured}`,
        revokeTargetConfigured ? "ok" : "warn"
      )
    );
  }
}

function renderEvidence(vm) {
  const detail = vm.evidence_detail;
  if (!detail) {
    dom.evidenceMeta.textContent = "Select an event in timeline to inspect evidence.";
    dom.evidenceRaw.textContent = "{}";
    dom.evidenceParsed.innerHTML = "";
    return;
  }
  const collapsedCount = Number.isFinite(detail.collapsed_count) ? detail.collapsed_count : 1;
  const collapsedMeta =
    collapsedCount > 1
      ? ` | collapsed x${collapsedCount} | range ${formatDate(
          detail.collapsed_start_timestamp
        )} -> ${formatDate(detail.collapsed_end_timestamp)}`
      : "";
  const validationMeta =
    detail.kernel_validation_status && detail.kernel_validation_status !== "pass"
      ? ` | validation=${detail.kernel_validation_status}`
      : "";
  const llmDomainMeta =
    detail.llm_domain_match === true
      ? ` | llm_domain=${detail.llm_domain || detail.llm_domain_rule || "matched"}`
      : "";
  const policyMeta =
    detail.policy_rule && typeof detail.policy_rule === "string"
      ? ` | policy_rule=${detail.policy_rule}`
      : "";
  dom.evidenceMeta.textContent = `${detail.event_type} | ${detail.severity} | ${formatDate(detail.timestamp)}${collapsedMeta}${validationMeta}${llmDomainMeta}${policyMeta}`;
  dom.evidenceRaw.textContent = JSON.stringify(detail.raw_evidence || {}, null, 2);
  dom.evidenceParsed.innerHTML = "";
  if (collapsedCount > 1) {
    dom.evidenceParsed.appendChild(
      createLi(`collapsed_count: ${collapsedCount}`)
    );
    dom.evidenceParsed.appendChild(
      createLi(`collapsed_range_start: ${formatDate(detail.collapsed_start_timestamp)}`)
    );
    dom.evidenceParsed.appendChild(
      createLi(`collapsed_range_end: ${formatDate(detail.collapsed_end_timestamp)}`)
    );
  }
  const fields = Array.isArray(detail.parsed_fields) ? detail.parsed_fields : [];
  const validationNotes = Array.isArray(detail.validation_notes) ? detail.validation_notes : [];
  if (validationNotes.length > 0) {
    for (const note of validationNotes) {
      dom.evidenceParsed.appendChild(
        createLi(
          `validation.${note.rule}: [${String(note.status || "unknown").toUpperCase()}] ${note.message}`
        )
      );
    }
  }
  if (fields.length === 0) {
    if (validationNotes.length === 0) {
      dom.evidenceParsed.appendChild(createLi("No parsed fields"));
    }
    return;
  }
  if (detail.llm_domain_match === true) {
    dom.evidenceParsed.appendChild(
      createLi(
        `llm_domain_match: ${detail.llm_domain || detail.llm_domain_rule || "matched"}`
      )
    );
  }
  for (const field of fields) {
    dom.evidenceParsed.appendChild(createLi(`${field.key}: ${JSON.stringify(field.value)}`));
  }
}

function renderTimeline(vm) {
  const timeline = Array.isArray(vm.event_timeline) ? vm.event_timeline : [];
  dom.timelineBody.innerHTML = "";
  dom.timelineEmpty.classList.toggle("hidden", timeline.length > 0);
  for (const item of timeline) {
    const tr = document.createElement("tr");
    const collapsedCount = Number.isFinite(item.collapsed_count) ? item.collapsed_count : 1;
    if (item.index === state.selectedEvidenceIndex) {
      tr.classList.add("active");
    }
    if (collapsedCount > 1) {
      tr.classList.add("collapsed-row");
      tr.title = `collapsed x${collapsedCount} (${formatDate(
        item.collapsed_start_timestamp
      )} -> ${formatDate(item.collapsed_end_timestamp)})`;
    }

    const timeCell = document.createElement("td");
    timeCell.textContent = formatDate(item.timestamp);
    tr.appendChild(timeCell);

    const typeCell = document.createElement("td");
    if (String(item.event_type || "").startsWith("KERNEL_")) {
      const kernelBadge = document.createElement("span");
      kernelBadge.className = "timeline-kernel-badge";
      kernelBadge.textContent = "kernel";
      typeCell.appendChild(kernelBadge);
      typeCell.appendChild(document.createTextNode(" "));
    }
    if (String(item.kernel_validation_status || "") === "warn") {
      const validationBadge = document.createElement("span");
      validationBadge.className = "timeline-validation-badge timeline-validation-warn";
      validationBadge.textContent = "validation warn";
      typeCell.appendChild(validationBadge);
      typeCell.appendChild(document.createTextNode(" "));
    }
    if (String(item.event_type || "") === "CLIENT_UPLOAD_STATUS") {
      const evidence = item.evidence && typeof item.evidence === "object" ? item.evidence : {};
      const recoveredBatches = Number(evidence.auth_recovered_batches || 0);
      const refreshFailedBatches = Number(evidence.auth_refresh_failed_batches || 0);
      const status = String(evidence.status || "").toLowerCase();
      if (recoveredBatches > 0 || status === "recovered") {
        const uploadRecoveredBadge = document.createElement("span");
        uploadRecoveredBadge.className = "timeline-upload-badge timeline-upload-recovered";
        uploadRecoveredBadge.textContent =
          recoveredBatches > 0 ? `upload recovered x${recoveredBatches}` : "upload recovered";
        typeCell.appendChild(uploadRecoveredBadge);
        typeCell.appendChild(document.createTextNode(" "));
      }
      if (refreshFailedBatches > 0) {
        const uploadFailedBadge = document.createElement("span");
        uploadFailedBadge.className = "timeline-upload-badge timeline-upload-failed";
        uploadFailedBadge.textContent = `auth refresh failed x${refreshFailedBatches}`;
        typeCell.appendChild(uploadFailedBadge);
        typeCell.appendChild(document.createTextNode(" "));
      } else if (status === "degraded") {
        const uploadFailedBadge = document.createElement("span");
        uploadFailedBadge.className = "timeline-upload-badge timeline-upload-failed";
        uploadFailedBadge.textContent = "upload degraded";
        typeCell.appendChild(uploadFailedBadge);
        typeCell.appendChild(document.createTextNode(" "));
      }
    }
    if (item.llm_domain_match === true) {
      const llmBadge = document.createElement("span");
      llmBadge.className = "timeline-llm-badge";
      llmBadge.textContent = item.llm_domain
        ? `llm domain: ${item.llm_domain}`
        : "llm domain";
      typeCell.appendChild(llmBadge);
      typeCell.appendChild(document.createTextNode(" "));
    }
    typeCell.appendChild(document.createTextNode(item.event_type));
    tr.appendChild(typeCell);

    const severityCell = document.createElement("td");
    const severityBadge = document.createElement("span");
    severityBadge.className = `severity-badge severity-${String(item.severity || "low").toLowerCase()}`;
    severityBadge.textContent = String(item.severity || "low");
    severityCell.appendChild(severityBadge);
    tr.appendChild(severityCell);

    const scoreCell = document.createElement("td");
    const scoreDelta = Number.isFinite(item.score_delta) ? item.score_delta : 0;
    scoreCell.textContent = scoreDelta > 0 ? `+${scoreDelta}` : String(scoreDelta);
    tr.appendChild(scoreCell);

    const descCell = document.createElement("td");
    if (collapsedCount > 1) {
      const collapseBadge = document.createElement("span");
      collapseBadge.className = "timeline-collapse-badge";
      collapseBadge.textContent = `x${collapsedCount}`;
      descCell.appendChild(collapseBadge);
      descCell.appendChild(document.createTextNode(" "));
    }
    descCell.appendChild(document.createTextNode(item.short_description || ""));
    tr.appendChild(descCell);

    tr.addEventListener("click", async () => {
      state.selectedEvidenceIndex = item.index;
      await loadInvestigation(state.selectedSessionId);
    });
    dom.timelineBody.appendChild(tr);
  }
}

function renderNotes() {
  dom.notesList.innerHTML = "";
  updateNotesPaginationUi();
  if (state.reviewNotes.length === 0) {
    dom.notesList.appendChild(createLi("No notes"));
    return;
  }
  for (const note of state.reviewNotes) {
    const relatedEventType =
      note.metadata && typeof note.metadata.related_event_type === "string"
        ? note.metadata.related_event_type
        : null;
    const relatedSeverity =
      note.metadata && typeof note.metadata.related_severity === "string"
        ? note.metadata.related_severity
        : null;
    const linkedEvent = relatedEventType ? ` [event=${relatedEventType}]` : "";
    const linkedSeverity = relatedSeverity ? ` [severity=${relatedSeverity}]` : "";
    const li = createLi(
      `[${formatDate(note.created_at)}] ${note.author}: ${note.note}${linkedEvent}${linkedSeverity}`
    );
    if (
      relatedEventType === getSelectedEventType() ||
      relatedSeverity === getSelectedSeverity() ||
      isLinkedToSelectedEvent(note.note)
    ) {
      li.classList.add("linked-item");
    }
    dom.notesList.appendChild(li);
  }
}

function renderActions() {
  dom.actionsList.innerHTML = "";
  updateActionsPaginationUi();
  if (state.reviewActions.length === 0) {
    dom.actionsList.appendChild(createLi("No manual actions"));
    return;
  }
  for (const action of state.reviewActions) {
    const reason = action.reason ? ` reason=${action.reason}` : "";
    const metadata =
      action && action.metadata && typeof action.metadata === "object" ? action.metadata : {};
    const relatedEventType =
      typeof metadata.related_event_type === "string"
        ? metadata.related_event_type
        : null;
    const relatedSeverity =
      typeof metadata.related_severity === "string"
        ? metadata.related_severity
        : null;
    const quickTemplate =
      typeof metadata.quick_template === "string" ? metadata.quick_template : null;
    const decisionReasonCode =
      typeof metadata.decision_reason_code === "string" ? metadata.decision_reason_code : null;
    const linkedEvent = relatedEventType ? ` event=${relatedEventType}` : "";
    const linkedSeverity = relatedSeverity ? ` severity=${relatedSeverity}` : "";
    const linkedTemplate = quickTemplate ? ` template=${quickTemplate}` : "";
    const linkedReasonCode = decisionReasonCode ? ` decision_reason_code=${decisionReasonCode}` : "";
    const li = createLi(
      `[${formatDate(action.created_at)}] ${action.actor}: ${action.action}${reason}${linkedEvent}${linkedSeverity}${linkedTemplate}${linkedReasonCode}`
    );
    const actionText = `${action.action} ${action.reason || ""}`;
    if (
      relatedEventType === getSelectedEventType() ||
      relatedSeverity === getSelectedSeverity() ||
      isLinkedToSelectedEvent(actionText)
    ) {
      li.classList.add("linked-item");
    }
    dom.actionsList.appendChild(li);
  }
}

function renderBans() {
  dom.bansList.innerHTML = "";
  updateBansPaginationUi();
  if (!state.bans.length) {
    dom.bansList.appendChild(createLi("No bans"));
    return;
  }
  for (const ban of state.bans) {
    const li = document.createElement("li");
    const meta = `[${ban.status}] ${ban.scope}:${ban.target_id} by ${ban.created_by} @ ${formatDate(
      ban.created_at
    )}`;
    const reason = ban.reason ? ` | reason=${ban.reason}` : "";
    li.textContent = `${meta}${reason}`;
    if (ban.status === "ACTIVE" && canEnforce()) {
      const row = document.createElement("div");
      row.className = "row";
      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.textContent = "Revoke";
      revokeBtn.addEventListener("click", async () => {
        await revokeBan(ban.ban_id);
      });
      row.appendChild(revokeBtn);
      li.appendChild(row);
    }
    dom.bansList.appendChild(li);
  }
}

function renderAudit() {
  dom.auditList.innerHTML = "";
  updateAuditPaginationUi();
  if (!state.auditLogs.length) {
    dom.auditList.appendChild(createLi("No audit logs"));
    return;
  }
  for (const item of state.auditLogs) {
    const detail = item.detail ? JSON.stringify(item.detail) : "{}";
    dom.auditList.appendChild(
      createLi(`[${formatDate(item.at)}] ${item.actor} -> ${item.action} (${item.object_type || "-"}/${item.object_id || "-"}) ${detail}`)
    );
  }
}

function renderViewModel(vm) {
  renderInvestigationStates(vm);
  renderSummary(vm);
  renderRisk(vm);
  renderTimeline(vm);
  renderEvidence(vm);
  renderNotes();
  renderActions();
}

async function loadInvestigation(sessionId) {
  if (!sessionId) {
    return;
  }
  setViewState({ loading: true, error: null, showContent: false });
  const filters = readInvestigationFiltersFromDom();
  syncInvestigationFilters(filters);
  const params = new URLSearchParams();
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.event_type) params.set("event_type", filters.event_type);
  if (filters.validation_failed_rule) {
    params.set("validation_failed_rule", filters.validation_failed_rule);
  }
  if (filters.collapse_noisy) params.set("collapse_noisy", "1");
  if (filters.validation_warn_only) params.set("validation_warn_only", "1");
  if (filters.llm_domain_only) params.set("llm_domain_only", "1");
  if (Number.isInteger(state.selectedEvidenceIndex)) {
    params.set("evidence_index", String(state.selectedEvidenceIndex + 1));
  }
  const path = `/v1/admin/investigation/${encodeURIComponent(sessionId)}${
    params.toString() ? `?${params}` : ""
  }`;
  try {
    const vm = await fetchJson(path);
    state.viewModel = vm;
    setViewState({ loading: false, error: null, showContent: true });
    renderViewModel(vm);
  } catch (error) {
    const message =
      error.status === 404
        ? "Failed to load investigation: session not found. Reload sessions."
        : `Failed to load investigation: ${error.message}`;
    setViewState({ loading: false, error: message, showContent: false });
  }
}

async function loadReviewNotes() {
  if (!state.adminToken) {
    state.reviewNotes = [];
    state.reviewNotesPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    renderNotes();
    setNotesState("Login required.");
    return;
  }
  if (!state.selectedSessionId) {
    state.reviewNotes = [];
    state.reviewNotesPage = {
      total: 0,
      offset: 0,
      limit: state.reviewNotesPage.limit,
      has_more: false,
      next_offset: null
    };
    renderNotes();
    setNotesState("Select a session to load notes.");
    return;
  }

  setNotesState("Loading notes...");
  const params = new URLSearchParams();
  const author = dom.notesAuthorFilter.value.trim();
  const relatedEventType = dom.notesRelatedEventTypeFilter.value.trim();
  const relatedSeverity = dom.notesRelatedSeverityFilter.value.trim();
  const from = toIsoOrNull(dom.notesFromInput.value);
  const to = toIsoOrNull(dom.notesToInput.value);
  const limit = Number(dom.notesLimitInput.value || 20);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  state.reviewNotesPage.limit = safeLimit;
  params.set("session_id", state.selectedSessionId);
  if (author) params.set("author", author);
  if (relatedEventType) params.set("related_event_type", relatedEventType);
  if (relatedSeverity) params.set("related_severity", relatedSeverity);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("limit", String(state.reviewNotesPage.limit));
  params.set("offset", String(state.reviewNotesPage.offset));

  try {
    const data = await fetchJson(`/v1/admin/review-notes?${params.toString()}`);
    state.reviewNotes = Array.isArray(data.items) ? data.items : [];
    const page = data.page || {};
    state.reviewNotesPage = {
      total: Number.isFinite(page.total) ? page.total : state.reviewNotes.length,
      offset: Number.isFinite(page.offset) ? page.offset : state.reviewNotesPage.offset,
      limit: Number.isFinite(page.limit) ? page.limit : state.reviewNotesPage.limit,
      has_more: Boolean(page.has_more),
      next_offset: Number.isFinite(page.next_offset) ? page.next_offset : null
    };
    renderNotes();
    setNotesState("");
  } catch (error) {
    setNotesState(`Failed to load notes: ${error.message}`);
  }
}

async function loadReviewActions() {
  if (!state.adminToken) {
    state.reviewActions = [];
    state.reviewActionsPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    renderActions();
    setActionsState("Login required.");
    return;
  }
  if (!state.selectedSessionId) {
    state.reviewActions = [];
    state.reviewActionsPage = {
      total: 0,
      offset: 0,
      limit: state.reviewActionsPage.limit,
      has_more: false,
      next_offset: null
    };
    renderActions();
    setActionsState("Select a session to load actions.");
    return;
  }

  setActionsState("Loading actions...");
  const params = new URLSearchParams();
  const actor = dom.actionsActorFilter.value.trim();
  const action = dom.actionsTypeFilter.value.trim();
  const relatedEventType = dom.actionsRelatedEventTypeFilter.value.trim();
  const relatedSeverity = dom.actionsRelatedSeverityFilter.value.trim();
  const from = toIsoOrNull(dom.actionsFromInput.value);
  const to = toIsoOrNull(dom.actionsToInput.value);
  const limit = Number(dom.actionsLimitInput.value || 20);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  state.reviewActionsPage.limit = safeLimit;
  params.set("session_id", state.selectedSessionId);
  if (actor) params.set("actor", actor);
  if (action) params.set("action", action);
  if (relatedEventType) params.set("related_event_type", relatedEventType);
  if (relatedSeverity) params.set("related_severity", relatedSeverity);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("limit", String(state.reviewActionsPage.limit));
  params.set("offset", String(state.reviewActionsPage.offset));

  try {
    const data = await fetchJson(`/v1/admin/review-actions?${params.toString()}`);
    state.reviewActions = Array.isArray(data.items) ? data.items : [];
    const page = data.page || {};
    state.reviewActionsPage = {
      total: Number.isFinite(page.total) ? page.total : state.reviewActions.length,
      offset: Number.isFinite(page.offset) ? page.offset : state.reviewActionsPage.offset,
      limit: Number.isFinite(page.limit) ? page.limit : state.reviewActionsPage.limit,
      has_more: Boolean(page.has_more),
      next_offset: Number.isFinite(page.next_offset) ? page.next_offset : null
    };
    renderActions();
    setActionsState("");
  } catch (error) {
    setActionsState(`Failed to load actions: ${error.message}`);
  }
}

async function loadBans() {
  if (!state.adminToken) {
    state.bans = [];
    state.bansPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    renderBans();
    setBansState("Login required.");
    return;
  }
  setBansState("Loading bans...");
  const params = new URLSearchParams();
  const status = dom.banStatusFilter.value.trim();
  const scope = dom.banScopeFilter.value.trim();
  const limit = Number(dom.banLimitInput.value || 20);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  state.bansPage.limit = safeLimit;
  if (status) params.set("status", status);
  if (scope) params.set("scope", scope);
  params.set("limit", String(state.bansPage.limit));
  params.set("offset", String(state.bansPage.offset));
  const path = `/v1/admin/bans${params.toString() ? `?${params}` : ""}`;
  try {
    const data = await fetchJson(path);
    state.bans = Array.isArray(data.items) ? data.items : [];
    const page = data.page || {};
    state.bansPage = {
      total: Number.isFinite(page.total) ? page.total : state.bans.length,
      offset: Number.isFinite(page.offset) ? page.offset : state.bansPage.offset,
      limit: Number.isFinite(page.limit) ? page.limit : state.bansPage.limit,
      has_more: Boolean(page.has_more),
      next_offset: Number.isFinite(page.next_offset) ? page.next_offset : null
    };
    renderBans();
    setBansState("");
  } catch (error) {
    setBansState(`Failed to load bans: ${error.message}`);
  }
}

async function loadAudit() {
  if (!state.adminToken) {
    state.auditLogs = [];
    state.auditPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    renderAudit();
    setAuditState("Login required.");
    return;
  }
  setAuditState("Loading audit logs...");
  const params = new URLSearchParams();
  const action = dom.auditActionFilter.value.trim();
  const actor = dom.auditActorFilter.value.trim();
  const from = toIsoOrNull(dom.auditFromInput.value);
  const to = toIsoOrNull(dom.auditToInput.value);
  const limit = Number(dom.auditLimitInput.value || 20);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  state.auditPage.limit = safeLimit;
  if (action) params.set("action", action);
  if (actor) params.set("actor", actor);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("limit", String(state.auditPage.limit));
  params.set("offset", String(state.auditPage.offset));
  const path = `/v1/admin/audit${params.toString() ? `?${params}` : ""}`;
  try {
    const data = await fetchJson(path);
    state.auditLogs = Array.isArray(data.items) ? data.items : [];
    const page = data.page || {};
    state.auditPage = {
      total: Number.isFinite(page.total) ? page.total : state.auditLogs.length,
      offset: Number.isFinite(page.offset) ? page.offset : state.auditPage.offset,
      limit: Number.isFinite(page.limit) ? page.limit : state.auditPage.limit,
      has_more: Boolean(page.has_more),
      next_offset: Number.isFinite(page.next_offset) ? page.next_offset : null
    };
    renderAudit();
    setAuditState("");
  } catch (error) {
    setAuditState(`Failed to load audit logs: ${error.message}`);
  }
}

async function createBan(event) {
  event.preventDefault();
  if (!canEnforce()) {
    setBansState("Current role cannot create bans.");
    return;
  }
  const scope = dom.banScope.value;
  const target_id = dom.banTargetId.value.trim();
  const duration_sec = Number(dom.banDurationSec.value || 0);
  const reason = dom.banReason.value.trim();
  if (!target_id || !reason) {
    setBansState("target_id and reason are required.");
    return;
  }
  try {
    await fetchJson("/v1/admin/bans", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        scope,
        target_id,
        duration_sec: Number.isFinite(duration_sec) ? Math.max(0, duration_sec) : 0,
        reason
      })
    });
    dom.banReason.value = "";
    state.bansPage.offset = 0;
    await loadBans();
    await loadSessions();
  } catch (error) {
    setBansState(`Failed to create ban: ${error.message}`);
  }
}

async function revokeBan(banId) {
  if (!canEnforce()) {
    setBansState("Current role cannot revoke bans.");
    return;
  }
  try {
    await fetchJson(`/v1/admin/bans/${encodeURIComponent(banId)}`, {
      method: "DELETE"
    });
    if (state.bansPage.offset > 0 && state.bans.length === 1) {
      state.bansPage.offset = Math.max(0, state.bansPage.offset - state.bansPage.limit);
    }
    await loadBans();
    await loadSessions();
  } catch (error) {
    setBansState(`Failed to revoke ban: ${error.message}`);
  }
}

async function selectSession(sessionId) {
  clearInvestigationReloadTimer();
  state.selectedSessionId = sessionId;
  writeSelectedSessionToUrl(sessionId);
  state.selectedEvidenceIndex = null;
  state.reviewNotesPage.offset = 0;
  state.reviewActionsPage.offset = 0;
  renderSessions();
  prefillBanTarget();
  await Promise.all([loadInvestigation(sessionId), loadReviewNotes(), loadReviewActions()]);
}

async function submitNote(event) {
  event.preventDefault();
  if (!canReview()) {
    setViewState({
      loading: false,
      error: "Current role cannot create review notes.",
      showContent: true
    });
    return;
  }
  const note = dom.noteText.value.trim();
  if (!note || !state.selectedSessionId) return;
  const relatedEventType = getSelectedEventType();
  const relatedSeverity = getSelectedSeverity();
  const metadata = {};
  if (relatedEventType) metadata.related_event_type = relatedEventType;
  if (relatedSeverity) metadata.related_severity = relatedSeverity;
  try {
    await fetchJson("/v1/admin/review-notes", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        session_id: state.selectedSessionId,
        note,
        metadata
      })
    });
    dom.noteText.value = "";
    state.reviewNotesPage.offset = 0;
    await loadReviewNotes();
  } catch (error) {
    setViewState({ loading: false, error: `Failed to add note: ${error.message}`, showContent: true });
  }
}

async function recordReviewAction(action, reason, extraMetadata = {}) {
  if (!canReview()) {
    setViewState({
      loading: false,
      error: "Current role cannot record review actions.",
      showContent: true
    });
    return false;
  }
  if (!state.selectedSessionId) return;
  const relatedEventType = getSelectedEventType();
  const relatedSeverity = getSelectedSeverity();
  const metadata = {};
  if (relatedEventType) metadata.related_event_type = relatedEventType;
  if (relatedSeverity) metadata.related_severity = relatedSeverity;
  if (extraMetadata && typeof extraMetadata === "object") {
    for (const [key, value] of Object.entries(extraMetadata)) {
      if (value === undefined || value === null || value === "") continue;
      metadata[key] = value;
    }
  }
  try {
    await fetchJson("/v1/admin/review-actions", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        session_id: state.selectedSessionId,
        action,
        reason: reason || undefined,
        metadata
      })
    });
    state.reviewActionsPage.offset = 0;
    await loadReviewActions();
    return true;
  } catch (error) {
    setViewState({
      loading: false,
      error: `Failed to record action: ${error.message}`,
      showContent: true
    });
    return false;
  }
}

async function submitAction(event) {
  event.preventDefault();
  const action = dom.actionType.value;
  const reason = dom.actionReason.value.trim();
  const guardrail = validateReviewActionGuardrails(action, reason);
  if (!guardrail.ok) {
    setActionsState(guardrail.message);
    showOperatorToast("warn", guardrail.message);
    return;
  }
  if (!confirmSensitiveReviewAction(action, reason, "manual_action_form")) {
    setActionsState(`Action cancelled by operator: ${action}`);
    showOperatorToast("warn", `Cancelled sensitive action (${action})`);
    return;
  }
  const submitted = await recordReviewAction(action, reason);
  if (submitted) {
    dom.actionReason.value = "";
  }
}

async function quickMarkReviewed() {
  dom.actionType.value = "mark_as_reviewed";
  onActionTypeChanged();
  const submitted = await recordReviewAction("mark_as_reviewed", "", {
    quick_template: "mark_reviewed_default"
  });
  if (submitted) {
    dom.actionReason.value = "";
    setActionsState("Quick action recorded: mark_as_reviewed");
    showOperatorToast("ok", "Quick action recorded: mark_as_reviewed");
  }
}

async function quickRequestFollowUp() {
  dom.actionType.value = "request_follow_up";
  onActionTypeChanged();
  const submitted = await recordReviewAction("request_follow_up", "", {
    quick_template: "request_follow_up_default",
    decision_reason_code: getSelectedSessionReasonCode()
  });
  if (submitted) {
    dom.actionReason.value = "";
    setActionsState("Quick action recorded: request_follow_up");
    showOperatorToast("warn", "Quick action recorded: request_follow_up");
  }
}

async function quickReasonTemplateAction() {
  if (!state.selectedSessionId) {
    setActionsState("Select a session first.");
    return;
  }
  const reasonCode = getSelectedSessionReasonCode();
  const template = buildReasonCodeQuickTemplate(reasonCode);
  dom.actionType.value = template.action;
  onActionTypeChanged();
  dom.actionReason.value = template.reason;
  const guardrail = validateReviewActionGuardrails(template.action, template.reason);
  if (!guardrail.ok) {
    setActionsState(guardrail.message);
    showOperatorToast("warn", guardrail.message);
    return;
  }
  if (!confirmSensitiveReviewAction(template.action, template.reason, template.template_code)) {
    setActionsState(`Quick template cancelled: ${template.template_code}`);
    showOperatorToast("warn", `Cancelled template (${template.template_code})`);
    return;
  }
  const submitted = await recordReviewAction(template.action, template.reason, {
    quick_template: template.template_code,
    decision_reason_code: reasonCode || "NONE"
  });
  if (submitted) {
    setActionsState(`Quick template recorded: ${template.template_code}`);
    showOperatorToast(
      template.toast_level || "warn",
      `Quick template applied (${template.template_code})`
    );
  }
}

function getSelectedSessionSummaryForActionConfirmation() {
  if (!state.selectedSessionId) return null;
  if (state.viewModel && state.viewModel.session) {
    return state.viewModel.session;
  }
  return state.sessions.find((item) => item.session_id === state.selectedSessionId) || null;
}

function buildSensitiveActionConfirmationMessage(action, reason, sourceTag = "manual_action") {
  const session = getSelectedSessionSummaryForActionConfirmation();
  const lines = [
    "Sensitive manual action confirmation",
    `Action: ${action}`,
    `Source: ${sourceTag}`,
    `Session: ${session && session.session_id ? session.session_id : state.selectedSessionId || "N/A"}`,
    `User: ${session && session.user_id ? session.user_id : "N/A"}`
  ];
  const reasonText = String(reason || "").trim();
  if (reasonText) {
    lines.push(`Reason: ${reasonText.slice(0, 240)}`);
  } else {
    lines.push("Reason: (empty)");
  }
  lines.push("");
  lines.push("Proceed with this action?");
  return lines.join("\n");
}

function confirmSensitiveReviewAction(action, reason, sourceTag = "manual_action") {
  if (!SENSITIVE_REVIEW_ACTIONS.has(action)) return true;
  if (typeof window === "undefined" || typeof window.confirm !== "function") {
    return true;
  }
  const message = buildSensitiveActionConfirmationMessage(action, reason, sourceTag);
  return window.confirm(message);
}

function validateReviewActionGuardrails(action, reason) {
  if (!SENSITIVE_REVIEW_ACTIONS.has(action)) {
    return { ok: true };
  }
  const normalizedReason = String(reason || "").trim();
  if (normalizedReason.length < 12) {
    return {
      ok: false,
      message:
        "Sensitive actions require evidence-based reason text (minimum 12 characters)."
    };
  }
  if (/^(test|tmp|none|n\/a)$/i.test(normalizedReason)) {
    return {
      ok: false,
      message: "Sensitive actions cannot use placeholder reason text."
    };
  }
  return { ok: true };
}

function onActionTypeChanged() {
  const required = SENSITIVE_REVIEW_ACTIONS.has(dom.actionType.value);
  dom.actionReason.required = required;
  dom.actionReason.placeholder = required
    ? "Reason (required, evidence-based, min 12 chars)"
    : "Reason";
}

async function applyAdminAuth(event) {
  event.preventDefault();
  state.adminKey = dom.adminKeyInput.value;
  const username = dom.adminUsernameInput.value.trim();
  const password = dom.adminPasswordInput.value;

  try {
    const payload = await fetchJson("/v1/admin/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username,
        password
      })
    });
    state.adminActor = payload.actor;
    state.adminRole = payload.role;
    state.adminToken = payload.access_token;
    state.selectedSessionId = null;
    writeSelectedSessionToUrl(null);
    state.selectedEvidenceIndex = null;
    state.viewModel = null;
    setAuthStatus(
      `Authenticated as ${state.adminActor} (${state.adminRole}), expires ${formatDate(
        payload.expires_at
      )}`
    );
    await loadRuntimeConfig();
    await loadSessions();
    await loadBans();
    await loadAudit();
  } catch (error) {
    state.adminActor = "";
    state.adminRole = "";
    state.adminToken = "";
    state.sessions = [];
    state.sessionsPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    state.bans = [];
    state.bansPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    state.auditLogs = [];
    state.auditPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    state.reviewNotes = [];
    state.reviewNotesPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    state.reviewActions = [];
    state.reviewActionsPage = {
      total: 0,
      offset: 0,
      limit: 20,
      has_more: false,
      next_offset: null
    };
    state.runtimeConfig = null;
    syncRuntimePolicyControlsFromConfig();
    state.gateFailureCounters = null;
    state.qualityMetrics = null;
    state.qualityTimeseries = null;
    state.operatorAlertSnapshot = null;
    if (dom.operatorToastHost) {
      dom.operatorToastHost.innerHTML = "";
    }
    dom.gateFailureCountersTags.innerHTML = "";
    dom.qualityMetricsSummary.innerHTML = "";
    dom.qualityTimeseriesBody.innerHTML = "";
    dom.qualityTimeseriesEmpty.classList.remove("hidden");
    resetQualityTimeseriesDetail("Login required to inspect trend details.");
    writeSelectedSessionToUrl(null);
    renderBans();
    renderAudit();
    renderNotes();
    renderActions();
    setAuthStatus(`Auth failed: ${error.message}`);
    setSessionsState("Login required.");
    setBansState("Login required.");
    setAuditState("Login required.");
    setNotesState("Login required.");
    setActionsState("Login required.");
    setGateFailureCountersState("Login required.");
    setRuntimePolicyControlState("Login required.");
    setQualityMetricsState("Login required.");
    setQualityTimeseriesState("Login required.");
    setViewState({
      loading: false,
      error: "Authenticate to access admin APIs.",
      showContent: false
    });
  }
}

function resetSessionsOffsetAndLoad() {
  syncSessionFilters(readSessionFiltersFromDom());
  state.sessionsPage.offset = 0;
  void loadSessions();
}

function applySessionKernelQuickFilter(mode) {
  const current = readSessionFiltersFromDom();
  if (mode === "warn") {
    syncSessionFilters({
      ...current,
      kernel_policy_only: true,
      kernel_policy_reason: "warn"
    });
  } else if (mode === "block") {
    syncSessionFilters({
      ...current,
      kernel_policy_only: true,
      kernel_policy_reason: "block"
    });
  } else {
    syncSessionFilters({
      ...current,
      kernel_policy_only: false,
      kernel_policy_reason: ""
    });
  }
  state.sessionsPage.offset = 0;
  void loadSessions();
}

function applySessionUploadQuickFilter(mode) {
  const current = readSessionFiltersFromDom();
  if (mode === "recovered" || mode === "degraded" || mode === "failed") {
    syncSessionFilters({
      ...current,
      upload_status: mode
    });
  } else {
    syncSessionFilters({
      ...current,
      upload_status: ""
    });
  }
  state.sessionsPage.offset = 0;
  void loadSessions();
}

function goSessionsPrevPage() {
  if (state.sessionsPage.offset <= 0) return;
  state.sessionsPage.offset = Math.max(0, state.sessionsPage.offset - state.sessionsPage.limit);
  void loadSessions();
}

function goSessionsNextPage() {
  if (!state.sessionsPage.has_more) return;
  if (Number.isFinite(state.sessionsPage.next_offset)) {
    state.sessionsPage.offset = state.sessionsPage.next_offset;
  } else {
    state.sessionsPage.offset += state.sessionsPage.limit;
  }
  void loadSessions();
}

function resetBansOffsetAndLoad() {
  state.bansPage.offset = 0;
  void loadBans();
}

function goBansPrevPage() {
  if (state.bansPage.offset <= 0) return;
  state.bansPage.offset = Math.max(0, state.bansPage.offset - state.bansPage.limit);
  void loadBans();
}

function goBansNextPage() {
  if (!state.bansPage.has_more) return;
  if (Number.isFinite(state.bansPage.next_offset)) {
    state.bansPage.offset = state.bansPage.next_offset;
  } else {
    state.bansPage.offset += state.bansPage.limit;
  }
  void loadBans();
}

function resetAuditOffsetAndLoad() {
  state.auditPage.offset = 0;
  void loadAudit();
}

function goAuditPrevPage() {
  if (state.auditPage.offset <= 0) return;
  state.auditPage.offset = Math.max(0, state.auditPage.offset - state.auditPage.limit);
  void loadAudit();
}

function goAuditNextPage() {
  if (!state.auditPage.has_more) return;
  if (Number.isFinite(state.auditPage.next_offset)) {
    state.auditPage.offset = state.auditPage.next_offset;
  } else {
    state.auditPage.offset += state.auditPage.limit;
  }
  void loadAudit();
}

function resetNotesOffsetAndLoad() {
  state.reviewNotesPage.offset = 0;
  void loadReviewNotes();
}

function goNotesPrevPage() {
  if (state.reviewNotesPage.offset <= 0) return;
  state.reviewNotesPage.offset = Math.max(
    0,
    state.reviewNotesPage.offset - state.reviewNotesPage.limit
  );
  void loadReviewNotes();
}

function goNotesNextPage() {
  if (!state.reviewNotesPage.has_more) return;
  if (Number.isFinite(state.reviewNotesPage.next_offset)) {
    state.reviewNotesPage.offset = state.reviewNotesPage.next_offset;
  } else {
    state.reviewNotesPage.offset += state.reviewNotesPage.limit;
  }
  void loadReviewNotes();
}

function resetActionsOffsetAndLoad() {
  state.reviewActionsPage.offset = 0;
  void loadReviewActions();
}

function goActionsPrevPage() {
  if (state.reviewActionsPage.offset <= 0) return;
  state.reviewActionsPage.offset = Math.max(
    0,
    state.reviewActionsPage.offset - state.reviewActionsPage.limit
  );
  void loadReviewActions();
}

function goActionsNextPage() {
  if (!state.reviewActionsPage.has_more) return;
  if (Number.isFinite(state.reviewActionsPage.next_offset)) {
    state.reviewActionsPage.offset = state.reviewActionsPage.next_offset;
  } else {
    state.reviewActionsPage.offset += state.reviewActionsPage.limit;
  }
  void loadReviewActions();
}

function applySelectedEventTypeToNotesFilter() {
  const eventType = getSelectedEventType();
  if (!eventType) {
    setNotesState("Select a timeline event first.");
    return;
  }
  dom.notesRelatedEventTypeFilter.value = eventType;
  resetNotesOffsetAndLoad();
}

function applySelectedEventTypeToActionsFilter() {
  const eventType = getSelectedEventType();
  if (!eventType) {
    setActionsState("Select a timeline event first.");
    return;
  }
  dom.actionsRelatedEventTypeFilter.value = eventType;
  resetActionsOffsetAndLoad();
}

function applySelectedSeverityToNotesFilter() {
  const severity = getSelectedSeverity();
  if (!severity) {
    setNotesState("Select a timeline event first.");
    return;
  }
  dom.notesRelatedSeverityFilter.value = severity;
  resetNotesOffsetAndLoad();
}

function applySelectedSeverityToActionsFilter() {
  const severity = getSelectedSeverity();
  if (!severity) {
    setActionsState("Select a timeline event first.");
    return;
  }
  dom.actionsRelatedSeverityFilter.value = severity;
  resetActionsOffsetAndLoad();
}

function bindEvents() {
  dom.tabInvestigationBtn.addEventListener("click", () => setActiveTab("investigation"));
  dom.tabBansBtn.addEventListener("click", async () => {
    setActiveTab("bans");
    await loadBans();
  });
  dom.tabAuditBtn.addEventListener("click", async () => {
    setActiveTab("audit");
    await loadAudit();
  });
  dom.reloadSessionsBtn.addEventListener("click", loadSessions);
  dom.sessionStatusFilter.addEventListener("change", resetSessionsOffsetAndLoad);
  dom.sessionUploadStatusFilter.addEventListener("change", resetSessionsOffsetAndLoad);
  dom.sessionUploadRecoveredOnlyBtn.addEventListener("click", () => {
    applySessionUploadQuickFilter("recovered");
  });
  dom.sessionUploadDegradedOnlyBtn.addEventListener("click", () => {
    applySessionUploadQuickFilter("degraded");
  });
  dom.sessionUploadFailedOnlyBtn.addEventListener("click", () => {
    applySessionUploadQuickFilter("failed");
  });
  dom.sessionUploadFilterClearBtn.addEventListener("click", () => {
    applySessionUploadQuickFilter("clear");
  });
  dom.sessionKernelPolicyOnly.addEventListener("change", () => {
    const current = readSessionFiltersFromDom();
    if (!current.kernel_policy_only) {
      current.kernel_policy_reason = "";
    }
    syncSessionFilters(current);
    resetSessionsOffsetAndLoad();
  });
  dom.sessionKernelWarnOnlyBtn.addEventListener("click", () => {
    applySessionKernelQuickFilter("warn");
  });
  dom.sessionKernelBlockOnlyBtn.addEventListener("click", () => {
    applySessionKernelQuickFilter("block");
  });
  dom.sessionParticipantGateOnlyBtn.addEventListener("click", () => {
    applySessionParticipantGateQuickFilter();
  });
  dom.sessionKernelFilterClearBtn.addEventListener("click", () => {
    applySessionKernelQuickFilter("clear");
  });
  dom.sessionLimitInput.addEventListener("change", resetSessionsOffsetAndLoad);
  dom.sessionPrevBtn.addEventListener("click", goSessionsPrevPage);
  dom.sessionNextBtn.addEventListener("click", goSessionsNextPage);
  dom.reloadGateFailureCountersBtn.addEventListener("click", () => {
    void loadGateFailureCounters();
  });
  dom.reloadRuntimePolicyBtn.addEventListener("click", () => {
    void loadRuntimeConfig();
  });
  dom.saveRuntimePolicyBtn.addEventListener("click", () => {
    void saveRuntimePolicy();
  });
  dom.reloadQualityTimeseriesBtn.addEventListener("click", () => {
    void loadDetectionQualityTimeseries();
  });
  dom.qualityTimeseriesFromInput.addEventListener("change", () => {
    void loadDetectionQualityTimeseries();
  });
  dom.qualityTimeseriesToInput.addEventListener("change", () => {
    void loadDetectionQualityTimeseries();
  });
  dom.qualityTimeseriesBucketsInput.addEventListener("change", () => {
    void loadDetectionQualityTimeseries();
  });
  dom.applyFiltersBtn.addEventListener("click", () => {
    scheduleInvestigationReload({ immediate: true, resetEvidence: true });
  });
  dom.autoApplyFiltersToggle.addEventListener("change", () => {
    writeInvestigationAutoApplyToStorage(Boolean(dom.autoApplyFiltersToggle.checked));
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    if (shouldAutoApplyInvestigationFilters()) {
      scheduleInvestigationReload({ immediate: true, resetEvidence: true });
    }
  });
  dom.presetValidationWarnBtn.addEventListener("click", () => {
    void applyInvestigationPreset("validation_warn");
  });
  dom.presetNonceReuseBtn.addEventListener("click", () => {
    void applyInvestigationPreset("bridge_nonce_reuse");
  });
  dom.presetFreshnessBtn.addEventListener("click", () => {
    void applyInvestigationPreset("bridge_freshness");
  });
  dom.presetLlmDomainBtn.addEventListener("click", () => {
    void applyInvestigationPreset("llm_domain");
  });
  dom.presetClearBtn.addEventListener("click", () => {
    void applyInvestigationPreset("clear");
  });
  dom.severityFilter.addEventListener("change", () => {
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    if (shouldAutoApplyInvestigationFilters()) {
      scheduleInvestigationReload({ immediate: true, resetEvidence: true });
    }
  });
  dom.eventTypeFilter.addEventListener("input", () => {
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    if (shouldAutoApplyInvestigationFilters()) {
      scheduleInvestigationReload({ immediate: false, resetEvidence: true });
    }
  });
  dom.eventTypeFilter.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    scheduleInvestigationReload({ immediate: true, resetEvidence: true });
  });
  dom.validationRuleFilter.addEventListener("change", async () => {
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    if (shouldAutoApplyInvestigationFilters()) {
      scheduleInvestigationReload({ immediate: true, resetEvidence: true });
    }
  });
  dom.collapseNoisyFilter.addEventListener("change", async () => {
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    if (shouldAutoApplyInvestigationFilters()) {
      scheduleInvestigationReload({ immediate: true, resetEvidence: true });
    }
  });
  dom.validationWarnOnlyFilter.addEventListener("change", async () => {
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    if (shouldAutoApplyInvestigationFilters()) {
      scheduleInvestigationReload({ immediate: true, resetEvidence: true });
    }
  });
  dom.llmDomainOnlyFilter.addEventListener("change", async () => {
    syncInvestigationFilters(readInvestigationFiltersFromDom());
    if (shouldAutoApplyInvestigationFilters()) {
      scheduleInvestigationReload({ immediate: true, resetEvidence: true });
    }
  });
  dom.noteForm.addEventListener("submit", submitNote);
  dom.noteText.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
    event.preventDefault();
    dom.noteForm.requestSubmit();
  });
  dom.reloadNotesBtn.addEventListener("click", loadReviewNotes);
  dom.notesUseSelectedEventTypeBtn.addEventListener("click", applySelectedEventTypeToNotesFilter);
  dom.notesUseSelectedSeverityBtn.addEventListener("click", applySelectedSeverityToNotesFilter);
  dom.notesAuthorFilter.addEventListener("change", resetNotesOffsetAndLoad);
  dom.notesRelatedEventTypeFilter.addEventListener("change", resetNotesOffsetAndLoad);
  dom.notesRelatedSeverityFilter.addEventListener("change", resetNotesOffsetAndLoad);
  dom.notesFromInput.addEventListener("change", resetNotesOffsetAndLoad);
  dom.notesToInput.addEventListener("change", resetNotesOffsetAndLoad);
  dom.notesLimitInput.addEventListener("change", resetNotesOffsetAndLoad);
  dom.notesPrevBtn.addEventListener("click", goNotesPrevPage);
  dom.notesNextBtn.addEventListener("click", goNotesNextPage);
  dom.actionForm.addEventListener("submit", submitAction);
  dom.actionReason.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
    event.preventDefault();
    dom.actionForm.requestSubmit();
  });
  dom.quickMarkReviewedBtn.addEventListener("click", () => {
    void quickMarkReviewed();
  });
  dom.quickRequestFollowUpBtn.addEventListener("click", () => {
    void quickRequestFollowUp();
  });
  dom.quickReasonTemplateActionBtn.addEventListener("click", () => {
    void quickReasonTemplateAction();
  });
  dom.reloadActionsBtn.addEventListener("click", loadReviewActions);
  dom.actionsUseSelectedEventTypeBtn.addEventListener(
    "click",
    applySelectedEventTypeToActionsFilter
  );
  dom.actionsUseSelectedSeverityBtn.addEventListener("click", applySelectedSeverityToActionsFilter);
  dom.actionsActorFilter.addEventListener("change", resetActionsOffsetAndLoad);
  dom.actionsTypeFilter.addEventListener("change", resetActionsOffsetAndLoad);
  dom.actionsRelatedEventTypeFilter.addEventListener("change", resetActionsOffsetAndLoad);
  dom.actionsRelatedSeverityFilter.addEventListener("change", resetActionsOffsetAndLoad);
  dom.actionsFromInput.addEventListener("change", resetActionsOffsetAndLoad);
  dom.actionsToInput.addEventListener("change", resetActionsOffsetAndLoad);
  dom.actionsLimitInput.addEventListener("change", resetActionsOffsetAndLoad);
  dom.actionsPrevBtn.addEventListener("click", goActionsPrevPage);
  dom.actionsNextBtn.addEventListener("click", goActionsNextPage);
  dom.banForm.addEventListener("submit", createBan);
  dom.reloadBansBtn.addEventListener("click", loadBans);
  dom.banStatusFilter.addEventListener("change", resetBansOffsetAndLoad);
  dom.banScopeFilter.addEventListener("change", resetBansOffsetAndLoad);
  dom.banLimitInput.addEventListener("change", resetBansOffsetAndLoad);
  dom.banPrevBtn.addEventListener("click", goBansPrevPage);
  dom.banNextBtn.addEventListener("click", goBansNextPage);
  dom.banScope.addEventListener("change", prefillBanTarget);
  dom.reloadAuditBtn.addEventListener("click", loadAudit);
  dom.auditActionFilter.addEventListener("change", resetAuditOffsetAndLoad);
  dom.auditActorFilter.addEventListener("change", resetAuditOffsetAndLoad);
  dom.auditFromInput.addEventListener("change", resetAuditOffsetAndLoad);
  dom.auditToInput.addEventListener("change", resetAuditOffsetAndLoad);
  dom.auditLimitInput.addEventListener("change", resetAuditOffsetAndLoad);
  dom.auditPrevBtn.addEventListener("click", goAuditPrevPage);
  dom.auditNextBtn.addEventListener("click", goAuditNextPage);
  dom.actionType.addEventListener("change", onActionTypeChanged);
  dom.adminAuthForm.addEventListener("submit", applyAdminAuth);
}

async function init() {
  bindEvents();
  const urlFilters = readInvestigationFiltersFromUrl();
  const storedFilters = readInvestigationFiltersFromStorage();
  const initialFilters = urlFilters || storedFilters || {};
  applyInvestigationFiltersToDom(initialFilters);
  syncInvestigationFilters(initialFilters);
  const storedAutoApply = readInvestigationAutoApplyFromStorage();
  if (storedAutoApply !== null) {
    dom.autoApplyFiltersToggle.checked = storedAutoApply;
  }
  const urlSessionFilters = readSessionFiltersFromUrl();
  const storedSessionFilters = readSessionFiltersFromStorage();
  const initialSessionFilters = urlSessionFilters || storedSessionFilters || {};
  applySessionFiltersToDom(initialSessionFilters);
  syncSessionFilters(initialSessionFilters);
  if (!dom.qualityTimeseriesFromInput.value && !dom.qualityTimeseriesToInput.value) {
    setDefaultTimeseriesRange();
  }
  if (!dom.qualityTimeseriesBucketsInput.value) {
    dom.qualityTimeseriesBucketsInput.value = "30";
  }
  state.selectedSessionId = readSelectedSessionFromUrl();
  setActiveTab("investigation");
  onActionTypeChanged();
  setAuthStatus("Not authenticated");
  setBansState("Login required.");
  setAuditState("Login required.");
  setNotesState("Select a session to load notes.");
  setActionsState("Select a session to load actions.");
  setGateFailureCountersState("Login required.");
  syncRuntimePolicyControlsFromConfig();
  setQualityMetricsState("Login required.");
  setQualityTimeseriesState("Login required.");
  resetQualityTimeseriesDetail();
  updateSessionsPaginationUi();
  updateBansPaginationUi();
  updateAuditPaginationUi();
  updateNotesPaginationUi();
  updateActionsPaginationUi();
  renderNotes();
  renderActions();
  setViewState({ loading: true, error: null, showContent: false });
  await loadSessions();
}

void init();
