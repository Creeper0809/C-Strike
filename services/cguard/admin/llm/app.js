"use strict";

const DEFAULT_CLI_HINTS = Object.freeze([
  "codex",
  "cursor",
  "aider",
  "ollama",
  "chatgpt-cli",
  "openai",
  "anthropic",
  "claude",
  "gemini",
  "llm "
]);

const DEFAULT_LLM_MONITOR_POLICY = Object.freeze({
  cliHints: [...DEFAULT_CLI_HINTS],
  weakConfidenceThreshold: 60,
  mediumConfidenceThreshold: 60,
  highConfidenceThreshold: 80,
  maxTopEvidence: 3
});

const LLM_REASON_ACTION_TEMPLATES = Object.freeze({
  CLI_USAGE_DETECTED: {
    action: "escalate",
    reason:
      "CLI usage indicators were observed in this session. Escalate for integrity review and request participant explanation.",
    template_code: "escalate_cli_usage_detected",
    toast_level: "error"
  },
  LLM_LINK_ACTIVITY_DETECTED: {
    action: "request_follow_up",
    reason:
      "LLM-domain activity was observed during an active session. Request follow-up verification and participant acknowledgment.",
    template_code: "follow_up_llm_domain_activity",
    toast_level: "warn"
  },
  LOW_CONFIDENCE_SIGNAL: {
    action: "request_follow_up",
    reason:
      "Weak-confidence signal observed. Request follow-up before taking irreversible enforcement action.",
    template_code: "follow_up_low_confidence_signal",
    toast_level: "warn"
  }
});

const AUTH_STORAGE_KEY = "antillm_llm_admin_auth_v1";
const MOCK_MODE = new URLSearchParams(window.location.search || "").get("mock") === "1";

const state = {
  token: "",
  adminKey: "",
  rows: [],
  refreshTimer: null,
  lastAlertSummary: null,
  toastSeq: 0,
  hasLoadedOnce: false,
  llmMonitorPolicy: {
    ...DEFAULT_LLM_MONITOR_POLICY
  }
};

const dom = {
  llmAuthForm: document.getElementById("llmAuthForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  adminKeyInput: document.getElementById("adminKeyInput"),
  authState: document.getElementById("authState"),
  viewState: document.getElementById("viewState"),
  reloadBtn: document.getElementById("reloadBtn"),
  limitInput: document.getElementById("limitInput"),
  showAllSessionsToggle: document.getElementById("showAllSessionsToggle"),
  autoRefreshToggle: document.getElementById("autoRefreshToggle"),
  refreshIntervalInput: document.getElementById("refreshIntervalInput"),
  summaryTags: document.getElementById("summaryTags"),
  llmRowsBody: document.getElementById("llmRowsBody"),
  operatorToastHost: document.getElementById("operatorToastHost")
};

function setAuthState(message) {
  dom.authState.textContent = message;
}

function setViewState(message) {
  dom.viewState.textContent = message;
}

function showOperatorToast(level, message, timeoutMs = 3800) {
  if (!dom.operatorToastHost) return;
  if (!message) return;
  const safeLevel = level === "error" || level === "warn" || level === "ok" ? level : "warn";
  const toast = document.createElement("div");
  toast.className = `operator-toast ${safeLevel}`;
  toast.textContent = message;
  state.toastSeq += 1;
  toast.dataset.seq = String(state.toastSeq);
  dom.operatorToastHost.appendChild(toast);
  window.setTimeout(() => {
    if (!dom.operatorToastHost || !toast.parentElement) return;
    toast.remove();
  }, timeoutMs);
}

function writeAuthToStorage() {
  const payload = {
    token: state.token || "",
    adminKey: state.adminKey || ""
  };
  window.sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(payload));
}

function readAuthFromStorage() {
  try {
    const raw = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      token: typeof parsed.token === "string" ? parsed.token : "",
      adminKey: typeof parsed.adminKey === "string" ? parsed.adminKey : ""
    };
  } catch (_error) {
    return null;
  }
}

function createTag(text, tone = "ok") {
  const node = document.createElement("span");
  node.className = `state-tag ${tone}`;
  node.textContent = text;
  return node;
}

function createBadge(text, tone = "ok") {
  const node = document.createElement("span");
  node.className = `badge ${tone}`;
  node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return "-";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

function normalizeLimit() {
  const raw = Number(dom.limitInput.value || 60);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  const safe = Math.max(1, Math.min(200, Math.floor(raw)));
  dom.limitInput.value = String(safe);
  return safe;
}

function normalizeRefreshIntervalMs() {
  const rawSec = Number(dom.refreshIntervalInput.value || 8);
  if (!Number.isFinite(rawSec) || rawSec < 3) {
    dom.refreshIntervalInput.value = "8";
    return 8000;
  }
  const safeSec = Math.min(60, Math.floor(rawSec));
  dom.refreshIntervalInput.value = String(safeSec);
  return safeSec * 1000;
}

function adminHeaders() {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (state.adminKey.trim()) headers["x-admin-key"] = state.adminKey.trim();
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
    const message = payload.message || payload.code || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function applyLlmMonitorPolicy(runtimeConfig) {
  const policy =
    runtimeConfig &&
    runtimeConfig.llm_monitor &&
    typeof runtimeConfig.llm_monitor === "object"
      ? runtimeConfig.llm_monitor
      : null;
  if (!policy) return;

  const cliHints = Array.isArray(policy.cli_hints)
    ? policy.cli_hints
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => item.length > 0)
    : [];
  const weakThreshold = Number(policy.weak_confidence_threshold);
  const mediumThreshold = Number(policy.medium_confidence_threshold);
  const highThreshold = Number(policy.high_confidence_threshold);
  const maxTopEvidence = Number(policy.max_top_evidence);

  state.llmMonitorPolicy = {
    cliHints: cliHints.length > 0 ? cliHints : [...DEFAULT_CLI_HINTS],
    weakConfidenceThreshold:
      Number.isFinite(weakThreshold) && weakThreshold > 0
        ? weakThreshold
        : DEFAULT_LLM_MONITOR_POLICY.weakConfidenceThreshold,
    mediumConfidenceThreshold:
      Number.isFinite(mediumThreshold) && mediumThreshold > 0
        ? mediumThreshold
        : DEFAULT_LLM_MONITOR_POLICY.mediumConfidenceThreshold,
    highConfidenceThreshold:
      Number.isFinite(highThreshold) && highThreshold > 0
        ? highThreshold
        : DEFAULT_LLM_MONITOR_POLICY.highConfidenceThreshold,
    maxTopEvidence:
      Number.isFinite(maxTopEvidence) && maxTopEvidence > 0
        ? Math.min(10, Math.floor(maxTopEvidence))
        : DEFAULT_LLM_MONITOR_POLICY.maxTopEvidence
  };
}

async function loadRuntimeLlmMonitorPolicy() {
  if (!state.token) return;
  try {
    const runtimeConfig = await fetchJson("/v1/admin/runtime-config");
    applyLlmMonitorPolicy(runtimeConfig);
  } catch (_error) {
    // Keep defaults if runtime config is temporarily unavailable.
  }
}

function stopAutoRefresh() {
  if (state.refreshTimer === null) return;
  window.clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

function startAutoRefreshIfNeeded() {
  stopAutoRefresh();
  if (!dom.autoRefreshToggle.checked) return;
  if (!state.token) return;
  const intervalMs = normalizeRefreshIntervalMs();
  state.refreshTimer = window.setInterval(() => {
    void loadLlmSessions();
  }, intervalMs);
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function detectCliHintFromStrings(strings) {
  const hints = Array.isArray(state.llmMonitorPolicy.cliHints)
    ? state.llmMonitorPolicy.cliHints
    : DEFAULT_CLI_HINTS;
  return hints.find((hint) => strings.some((text) => text.includes(hint))) || null;
}

function extractEvidenceStrings(item) {
  const bag = [];
  const timelineEvidence = item && item.evidence && typeof item.evidence === "object" ? item.evidence : {};
  const processValue = normalizeText(item && item.process);
  if (processValue) bag.push(processValue);

  const directKeys = ["command_line", "executable_path", "process_name", "description", "remote_host"];
  for (const key of directKeys) {
    const normalized = normalizeText(timelineEvidence[key]);
    if (normalized) bag.push(normalized);
  }

  const matches = Array.isArray(timelineEvidence.matches) ? timelineEvidence.matches : [];
  for (const match of matches) {
    if (!match || typeof match !== "object") continue;
    for (const value of Object.values(match)) {
      const normalized = normalizeText(value);
      if (normalized) bag.push(normalized);
    }
  }
  return bag;
}

function detectCliSignals(timeline) {
  const items = Array.isArray(timeline) ? timeline : [];
  const reasons = [];
  const dedupe = new Set();

  for (const event of items) {
    const strings = extractEvidenceStrings(event);
    const matchedHint = detectCliHintFromStrings(strings);
    if (!matchedHint) continue;
    const key = `${event.event_type || "unknown"}|${event.timestamp || ""}|${matchedHint}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    reasons.push({
      event_type: event.event_type || "unknown",
      timestamp: event.timestamp || null,
      process: event.process || null,
      matched_hint: matchedHint,
      command_line:
        event && event.evidence && typeof event.evidence === "object"
          ? event.evidence.command_line || null
          : null,
      executable_path:
        event && event.evidence && typeof event.evidence === "object"
          ? event.evidence.executable_path || null
          : null
    });
  }

  return {
    cliDetected: reasons.length > 0,
    reasons
  };
}

function summarizeTopEvidence(timeline) {
  const items = Array.isArray(timeline) ? timeline : [];
  const candidates = [];
  const dedupe = new Set();
  for (const event of items) {
    if (!event || typeof event !== "object") continue;
    const evidence = event.evidence && typeof event.evidence === "object" ? event.evidence : {};
    const strings = extractEvidenceStrings(event);
    const cliHint = detectCliHintFromStrings(strings);
    const llmDomain = typeof event.llm_domain === "string" ? event.llm_domain.trim() : "";
    const severity = normalizeText(event.severity || "low");
    let score = 0;
    let label = "";

    if (event.llm_domain_match === true && llmDomain) {
      score += 70;
      label = `WEB domain: ${llmDomain}`;
    } else if (cliHint) {
      score += 65;
      const process = normalizeText(event.process || evidence.process_name || "");
      label = process ? `CLI hint: ${cliHint} (${process})` : `CLI hint: ${cliHint}`;
    } else if (typeof evidence.remote_host === "string" && evidence.remote_host.trim()) {
      score += 35;
      label = `Network host: ${evidence.remote_host.trim()}`;
    } else if (typeof event.event_type === "string" && event.event_type.trim()) {
      score += 20;
      label = `Event: ${event.event_type.trim()}`;
    }

    if (!label) continue;
    if (severity === "critical" || severity === "high") score += 30;
    else if (severity === "medium" || severity === "warn") score += 15;
    else score += 5;
    const key = `${label}|${event.timestamp || ""}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    candidates.push({
      label,
      score,
      timestamp: event.timestamp || null
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = Date.parse(a.timestamp || "");
    const bt = Date.parse(b.timestamp || "");
    const aVal = Number.isNaN(at) ? 0 : at;
    const bVal = Number.isNaN(bt) ? 0 : bt;
    return bVal - aVal;
  });
  const maxTopEvidence = Number.isFinite(Number(state.llmMonitorPolicy.maxTopEvidence))
    ? Math.max(1, Math.min(10, Math.floor(Number(state.llmMonitorPolicy.maxTopEvidence))))
    : 3;
  return candidates.slice(0, maxTopEvidence).map((item) => item.label);
}

function buildLlmLink(latestDomain) {
  if (!latestDomain) return "";
  const normalized = String(latestDomain || "").trim();
  if (!normalized) return "";
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return normalized;
  }
  return `https://${normalized}`;
}

function toCGuardState(session) {
  const clientRunning = normalizeText(session.health_client_agent_state) === "running";
  const kernelConnected = normalizeText(session.health_kernel_bridge_state) === "connected";
  const driverLoaded = session.health_kernel_driver_loaded === true;
  return clientRunning && kernelConnected && driverLoaded;
}

function deriveAlertLevel({ status, llmCount, cliDetected, usageClass, confidence, cGuardOn }) {
  const normalizedStatus = normalizeText(status);
  const safeConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  const mediumThreshold = Number.isFinite(Number(state.llmMonitorPolicy.mediumConfidenceThreshold))
    ? Number(state.llmMonitorPolicy.mediumConfidenceThreshold)
    : DEFAULT_LLM_MONITOR_POLICY.mediumConfidenceThreshold;
  const highThreshold = Number.isFinite(Number(state.llmMonitorPolicy.highConfidenceThreshold))
    ? Number(state.llmMonitorPolicy.highConfidenceThreshold)
    : DEFAULT_LLM_MONITOR_POLICY.highConfidenceThreshold;
  if (normalizedStatus === "blocked") return "high";
  if (!cGuardOn && (llmCount > 0 || cliDetected)) return "high";
  if (usageClass === "MIXED" && safeConfidence >= highThreshold) return "high";
  if (safeConfidence >= highThreshold) return "high";
  if ((llmCount > 0 || cliDetected) && safeConfidence >= mediumThreshold) return "medium";
  if (llmCount > 0 || cliDetected) return "medium";
  if (!cGuardOn) return "medium";
  return "low";
}

function toneFromAlertLevel(level) {
  if (level === "high") return "error";
  if (level === "medium") return "warn";
  return "ok";
}

function buildBypassCaveat({ usageClass, confidence, llmCount, cliDetected }) {
  const safeConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  const weakThreshold = Number.isFinite(Number(state.llmMonitorPolicy.weakConfidenceThreshold))
    ? Number(state.llmMonitorPolicy.weakConfidenceThreshold)
    : DEFAULT_LLM_MONITOR_POLICY.weakConfidenceThreshold;
  if (usageClass === "UNKNOWN") {
    return "No strong WEB/CLI classification evidence. Treat as triage-only and review full timeline.";
  }
  if (safeConfidence < weakThreshold && (llmCount > 0 || cliDetected)) {
    return "Low-confidence signal. Proxy/off-device/renamed process bypass is still possible.";
  }
  if (usageClass === "CLI" && llmCount === 0) {
    return "CLI-only evidence may include tool-name collisions. Verify command-line and parent process chain.";
  }
  if (usageClass === "WEB" && !cliDetected) {
    return "WEB-only evidence can miss API/CLI channels. Confirm with additional telemetry before hard enforcement.";
  }
  return "";
}

function buildActionTemplate(row) {
  const reasonCode =
    row.decisionReasonCode ||
    (row.cliDetected ? "CLI_USAGE_DETECTED" : row.llmCount > 0 ? "LLM_LINK_ACTIVITY_DETECTED" : "LOW_CONFIDENCE_SIGNAL");
  return (
    LLM_REASON_ACTION_TEMPLATES[reasonCode] ||
    LLM_REASON_ACTION_TEMPLATES.LOW_CONFIDENCE_SIGNAL
  );
}

function buildBanTemplate(row) {
  const reasonCode = row.cliDetected ? "CLI_USAGE_DETECTED" : "LLM_LINK_ACTIVITY_DETECTED";
  if (reasonCode === "CLI_USAGE_DETECTED") {
    return {
      reasonCode,
      reason: "Session blocked from LLM monitor: CLI usage indicators detected."
    };
  }
  return {
    reasonCode,
    reason: "Session blocked from LLM monitor: LLM-domain activity detected."
  };
}

function classifyLlmUsage({ llmCount, cliDetected }) {
  const hasWeb = Number(llmCount || 0) > 0;
  const hasCli = cliDetected === true;
  if (hasWeb && hasCli) return "MIXED";
  if (hasWeb) return "WEB";
  if (hasCli) return "CLI";
  return "UNKNOWN";
}

function calculateLlmUsageConfidence({
  usageClass,
  llmCount,
  cliReasonCount,
  latestTime
}) {
  const safeLlmCount = Math.max(0, Number(llmCount || 0));
  const safeCliReasonCount = Math.max(0, Number(cliReasonCount || 0));
  const now = Date.now();
  const latestTs = Date.parse(latestTime || "");
  const isRecent = Number.isFinite(latestTs) && now - latestTs <= 5 * 60 * 1000;

  let score = 10;
  if (usageClass === "WEB") {
    score = 55 + Math.min(25, safeLlmCount * 8);
    if (isRecent) score += 5;
  } else if (usageClass === "CLI") {
    score = 60 + Math.min(25, safeCliReasonCount * 10);
    if (isRecent) score += 5;
  } else if (usageClass === "MIXED") {
    score = 80 + Math.min(15, safeLlmCount * 3 + safeCliReasonCount * 4);
  }
  return Math.max(0, Math.min(99, Math.round(score)));
}

function toRow(session, investigation, sessionSummary) {
  const timeline = Array.isArray(investigation && investigation.event_timeline)
    ? investigation.event_timeline
    : [];
  const llmEvents = timeline.filter((item) => item && item.llm_domain_match === true);
  const latestLlmEvent = llmEvents.length > 0 ? llmEvents[llmEvents.length - 1] : null;
  const cliSignal = detectCliSignals(timeline);
  const username = session.username ? String(session.username) : "";
  const latestTime =
    (latestLlmEvent && latestLlmEvent.timestamp) ||
    session.last_heartbeat_at ||
    session.updated_at ||
    "";
  const usageClass = classifyLlmUsage({
    llmCount: llmEvents.length,
    cliDetected: cliSignal.cliDetected
  });
  const confidence = calculateLlmUsageConfidence({
    usageClass,
    llmCount: llmEvents.length,
    cliReasonCount: cliSignal.reasons.length,
    latestTime
  });
  const discordIdentityPolicy =
    typeof session.discord_identity_policy === "string"
      ? String(session.discord_identity_policy).toLowerCase()
      : "none";
  const discordIdentityPolicyReasonCode =
    typeof session.discord_identity_policy_reason_code === "string"
      ? session.discord_identity_policy_reason_code
      : "";
  const topEvidence = summarizeTopEvidence(timeline);
  const alertLevel = deriveAlertLevel({
    status: session.status,
    llmCount: llmEvents.length,
    cliDetected: cliSignal.cliDetected,
    usageClass,
    confidence,
    cGuardOn: toCGuardState(session)
  });
  const bypassCaveat = buildBypassCaveat({
    usageClass,
    confidence,
    llmCount: llmEvents.length,
    cliDetected: cliSignal.cliDetected
  });
  return {
    sessionId: session.session_id,
    userId: session.user_id,
    username,
    userDisplay: `${username || "unknown"} [${session.user_id}]`,
    status: session.status,
    decisionReasonCode: session.decision_reason_code || discordIdentityPolicyReasonCode || "",
    discordIdentityPolicy,
    discordIdentityPolicyReasonCode,
    statusReasonCodes,
    rootReasonCode,
    llmCount: llmEvents.length,
    latestDomain: latestLlmEvent && latestLlmEvent.llm_domain ? latestLlmEvent.llm_domain : "",
    latestTime,
    llmLink: buildLlmLink(latestLlmEvent && latestLlmEvent.llm_domain),
    cliDetected: cliSignal.cliDetected,
    cliReasonCount: cliSignal.reasons.length,
    usageClass,
    confidence,
    cGuardOn: toCGuardState(session),
    topEvidence,
    alertLevel,
    bypassCaveat,
    lastHeartbeatAt: session.last_heartbeat_at || "",
    banDisabled: String(session.status || "").toUpperCase() === "BLOCKED"
  };
}

function applyViewFilter(rows) {
  if (dom.showAllSessionsToggle.checked) return rows;
  return rows.filter((row) => row.llmCount > 0 || row.cliDetected);
}

function renderSummary(rows) {
  dom.summaryTags.innerHTML = "";
  const total = rows.length;
  const llmFlagged = rows.filter((row) => row.llmCount > 0).length;
  const cliFlagged = rows.filter((row) => row.cliDetected).length;
  const webOnly = rows.filter((row) => row.usageClass === "WEB").length;
  const cliOnly = rows.filter((row) => row.usageClass === "CLI").length;
  const mixed = rows.filter((row) => row.usageClass === "MIXED").length;
  const blocked = rows.filter((row) => String(row.status).toUpperCase() === "BLOCKED").length;
  const cGuardOff = rows.filter((row) => !row.cGuardOn).length;
  const discordPolicyActive = rows.filter((row) => row.discordIdentityPolicy !== "none").length;
  const highRisk = rows.filter((row) => row.alertLevel === "high").length;
  const mediumRisk = rows.filter((row) => row.alertLevel === "medium").length;
  const weakConfidence = rows.filter((row) => String(row.bypassCaveat || "").trim() !== "").length;
  dom.summaryTags.appendChild(createTag(`sessions=${total}`, "ok"));
  dom.summaryTags.appendChild(createTag(`risk_high=${highRisk}`, highRisk > 0 ? "error" : "ok"));
  dom.summaryTags.appendChild(createTag(`risk_medium=${mediumRisk}`, mediumRisk > 0 ? "warn" : "ok"));
  dom.summaryTags.appendChild(
    createTag(`weak_confidence=${weakConfidence}`, weakConfidence > 0 ? "warn" : "ok")
  );
  dom.summaryTags.appendChild(createTag(`llm_flagged=${llmFlagged}`, llmFlagged > 0 ? "warn" : "ok"));
  dom.summaryTags.appendChild(createTag(`cli_flagged=${cliFlagged}`, cliFlagged > 0 ? "warn" : "ok"));
  dom.summaryTags.appendChild(createTag(`web=${webOnly}`, webOnly > 0 ? "warn" : "ok"));
  dom.summaryTags.appendChild(createTag(`cli=${cliOnly}`, cliOnly > 0 ? "warn" : "ok"));
  dom.summaryTags.appendChild(createTag(`mixed=${mixed}`, mixed > 0 ? "error" : "ok"));
  dom.summaryTags.appendChild(createTag(`c_guard_off=${cGuardOff}`, cGuardOff > 0 ? "error" : "ok"));
  dom.summaryTags.appendChild(
    createTag(`discord_policy=${discordPolicyActive}`, discordPolicyActive > 0 ? "warn" : "ok")
  );
  dom.summaryTags.appendChild(createTag(`blocked=${blocked}`, blocked > 0 ? "warn" : "ok"));
}

function maybeNotifyAlertSummary(rows) {
  const summary = {
    high: rows.filter((row) => row.alertLevel === "high").length,
    medium: rows.filter((row) => row.alertLevel === "medium").length
  };
  if (!state.hasLoadedOnce) {
    state.lastAlertSummary = summary;
    state.hasLoadedOnce = true;
    return;
  }
  const prev = state.lastAlertSummary || { high: 0, medium: 0 };
  if (summary.high > prev.high) {
    showOperatorToast(
      "error",
      `High-risk sessions increased: ${prev.high} -> ${summary.high}`
    );
  } else if (summary.medium > prev.medium) {
    showOperatorToast(
      "warn",
      `Medium-risk sessions increased: ${prev.medium} -> ${summary.medium}`
    );
  } else if ((prev.high > 0 || prev.medium > 0) && summary.high === 0 && summary.medium === 0) {
    showOperatorToast("ok", "All current sessions are in low-risk state.");
  }
  state.lastAlertSummary = summary;
}

function buildReasonUrl(row) {
  // URL policy: reason drill-down is session_id scoped only.
  const params = new URLSearchParams();
  params.set("session_id", row.sessionId);
  if (MOCK_MODE) {
    params.set("mock", "1");
  }
  return `/admin/llm/reason?${params.toString()}`;
}

async function onBanSession(row) {
  if (!state.token) {
    setViewState("Login first.");
    return;
  }
  if (row.banDisabled) {
    setViewState(`Session ${row.sessionId} is already blocked.`);
    return;
  }
  const confirmed = window.confirm(
    `Ban session ${row.sessionId} for ${row.userDisplay}?\nThis creates an active session ban.`
  );
  if (!confirmed) return;

  try {
    const banTemplate = buildBanTemplate(row);
    await fetchJson("/v1/admin/bans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "session",
        target_id: row.sessionId,
        reason: banTemplate.reason,
        reason_code: banTemplate.reasonCode,
        duration_sec: 0
      })
    });
    setViewState(`Ban created for session ${row.sessionId}.`);
    showOperatorToast("error", `Session banned: ${row.sessionId}`);
    await loadLlmSessions();
  } catch (error) {
    setViewState(`Failed to ban session ${row.sessionId}: ${error.message}`);
    showOperatorToast("error", `Ban failed (${row.sessionId}): ${error.message}`);
  }
}

async function onTemplateAction(row) {
  if (!state.token) {
    setViewState("Login first.");
    return;
  }
  const template = buildActionTemplate(row);
  const sensitive = template.action === "escalate" || template.action === "clear_with_reason";
  if (sensitive) {
    const confirmed = window.confirm(
      `Apply sensitive action '${template.action}' to session ${row.sessionId}?\nTemplate: ${template.template_code}`
    );
    if (!confirmed) return;
  }
  try {
    await fetchJson("/v1/admin/review-actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: row.sessionId,
        action: template.action,
        reason: template.reason,
        metadata: {
          quick_template: template.template_code,
          decision_reason_code: row.decisionReasonCode || "NONE"
        }
      })
    });
    setViewState(`Template action applied: ${template.template_code} (${row.sessionId}).`);
    showOperatorToast(
      template.toast_level || "warn",
      `Template action applied: ${template.template_code}`
    );
    await loadLlmSessions();
  } catch (error) {
    setViewState(`Template action failed (${row.sessionId}): ${error.message}`);
    showOperatorToast("error", `Template action failed: ${error.message}`);
  }
}

function renderRows(rows) {
  dom.llmRowsBody.innerHTML = "";
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 15;
    td.className = "empty";
    td.textContent = "No sessions available for current filter.";
    tr.appendChild(td);
    dom.llmRowsBody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.llmCount > 0 || row.cliDetected) tr.classList.add("llm-positive");
    if (row.alertLevel === "high") tr.classList.add("llm-high-risk");

    const userTd = document.createElement("td");
    userTd.innerHTML = `<code class="inline">${row.userDisplay}</code>`;

    const sessionTd = document.createElement("td");
    sessionTd.innerHTML = `<a class="session-link" href="${buildReasonUrl(row)}" target="_blank" rel="noreferrer"><code>${row.sessionId}</code></a>`;

    const cGuardTd = document.createElement("td");
    cGuardTd.appendChild(createBadge(row.cGuardOn ? "ON" : "OFF", row.cGuardOn ? "ok" : "error"));

    const statusTd = document.createElement("td");
    statusTd.textContent = row.status || "-";

    const llmCountTd = document.createElement("td");
    llmCountTd.textContent = String(row.llmCount);

    const llmLinkTd = document.createElement("td");
    if (row.llmLink) {
      const link = document.createElement("a");
      link.href = row.llmLink;
      link.className = "domain-link";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = row.latestDomain;
      llmLinkTd.appendChild(link);
    } else {
      llmLinkTd.textContent = "-";
    }

    const cliTd = document.createElement("td");
    cliTd.appendChild(
      createBadge(
        row.cliDetected ? `yes (${row.cliReasonCount})` : "no",
        row.cliDetected ? "warn" : "ok"
      )
    );

    const classTd = document.createElement("td");
    const classTone = row.usageClass === "MIXED" ? "error" : row.usageClass === "UNKNOWN" ? "muted" : "warn";
    classTd.appendChild(createBadge(row.usageClass || "UNKNOWN", classTone));

    const confidenceTd = document.createElement("td");
    const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0;
    const confidenceTone = toneFromAlertLevel(row.alertLevel);
    confidenceTd.appendChild(createBadge(`${confidence}%`, confidenceTone));
    if (row.bypassCaveat) {
      const caveat = document.createElement("div");
      caveat.className = "bypass-caveat";
      caveat.textContent = row.bypassCaveat;
      confidenceTd.appendChild(caveat);
    }

    const topEvidenceTd = document.createElement("td");
    if (Array.isArray(row.topEvidence) && row.topEvidence.length > 0) {
      const list = document.createElement("ul");
      list.className = "evidence-list";
      for (const item of row.topEvidence) {
        const li = document.createElement("li");
        li.textContent = item;
        list.appendChild(li);
      }
      topEvidenceTd.appendChild(list);
    } else {
      topEvidenceTd.textContent = "-";
    }

    const latestTimeTd = document.createElement("td");
    latestTimeTd.textContent = formatDate(row.latestTime);

    const decisionTd = document.createElement("td");
    decisionTd.innerHTML = `<div><code>${row.decisionReasonCode || "-"}</code></div>
      <div class="decision-root">root: <code>${row.rootReasonCode || "-"}</code></div>`;

    const reasonTd = document.createElement("td");
    const reasonLink = document.createElement("a");
    reasonLink.href = buildReasonUrl(row);
    reasonLink.className = "mini-btn secondary";
    reasonLink.target = "_blank";
    reasonLink.rel = "noreferrer";
    reasonLink.textContent = "Reason";
    reasonTd.appendChild(reasonLink);

    const actionTd = document.createElement("td");
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "mini-btn";
    const template = buildActionTemplate(row);
    actionBtn.textContent = template.action === "escalate" ? "Escalate" : "Follow-up";
    actionBtn.addEventListener("click", () => {
      void onTemplateAction(row);
    });
    actionTd.appendChild(actionBtn);

    const banTd = document.createElement("td");
    const banBtn = document.createElement("button");
    banBtn.type = "button";
    banBtn.className = "mini-btn danger";
    banBtn.textContent = row.banDisabled ? "Banned" : "Ban";
    banBtn.disabled = row.banDisabled;
    banBtn.addEventListener("click", () => {
      void onBanSession(row);
    });
    banTd.appendChild(banBtn);

    tr.append(
      userTd,
      sessionTd,
      cGuardTd,
      statusTd,
      llmCountTd,
      llmLinkTd,
      cliTd,
      classTd,
      confidenceTd,
      topEvidenceTd,
      latestTimeTd,
      decisionTd,
      reasonTd,
      actionTd,
      banTd
    );
    dom.llmRowsBody.appendChild(tr);
  }
}

async function loadLlmSessions() {
  if (!state.token) {
    setViewState("Login first.");
    return;
  }
  setViewState("Loading LLM monitor data...");

  try {
    const limit = normalizeLimit();
    const sessionsPayload = await fetchJson(`/v1/admin/sessions?limit=${limit}&offset=0`);
    const sessions = Array.isArray(sessionsPayload.items) ? sessionsPayload.items : [];

    const mapped = await Promise.all(
      sessions.map(async (session) => {
        const sid = encodeURIComponent(session.session_id);
        try {
          const [inv, summary] = await Promise.all([
            fetchJson(`/v1/admin/investigation/${sid}?collapse_noisy=1`),
            fetchJson(`/v1/admin/session-summary/${sid}`)
          ]);
          return toRow(session, inv, summary);
        } catch (_error) {
          return toRow(session, { event_timeline: [] }, null);
        }
      })
    );

    mapped.sort((a, b) => {
      const at = Date.parse(a.latestTime || a.lastHeartbeatAt || "");
      const bt = Date.parse(b.latestTime || b.lastHeartbeatAt || "");
      const aVal = Number.isNaN(at) ? 0 : at;
      const bVal = Number.isNaN(bt) ? 0 : bt;
      return bVal - aVal;
    });

    state.rows = mapped;
    maybeNotifyAlertSummary(mapped);
    const viewRows = applyViewFilter(mapped);
    renderSummary(mapped);
    renderRows(viewRows);
    setViewState(`Loaded ${viewRows.length} rows (total sessions: ${mapped.length}).`);
  } catch (error) {
    setViewState(`Failed to load monitor data: ${error.message}`);
    renderRows([]);
  }
}

async function onLogin(event) {
  event.preventDefault();
  const username = dom.usernameInput.value.trim();
  const password = dom.passwordInput.value;
  state.adminKey = dom.adminKeyInput.value;

  try {
    const payload = await fetchJson("/v1/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    state.token = payload.access_token || "";
    writeAuthToStorage();
    setAuthState(`Authenticated as ${payload.actor} (${payload.role})`);
    await loadRuntimeLlmMonitorPolicy();
    await loadLlmSessions();
    startAutoRefreshIfNeeded();
  } catch (error) {
    state.token = "";
    setAuthState(`Auth failed: ${error.message}`);
    setViewState("Login failed.");
    stopAutoRefresh();
  }
}

function bindEvents() {
  dom.llmAuthForm.addEventListener("submit", onLogin);
  dom.reloadBtn.addEventListener("click", () => {
    void loadLlmSessions();
  });
  dom.showAllSessionsToggle.addEventListener("change", () => {
    const viewRows = applyViewFilter(state.rows);
    renderRows(viewRows);
    setViewState(`Loaded ${viewRows.length} rows (total sessions: ${state.rows.length}).`);
  });
  dom.limitInput.addEventListener("change", () => {
    normalizeLimit();
    void loadLlmSessions();
  });
  dom.autoRefreshToggle.addEventListener("change", () => {
    startAutoRefreshIfNeeded();
  });
  dom.refreshIntervalInput.addEventListener("change", () => {
    startAutoRefreshIfNeeded();
  });
}

function init() {
  bindEvents();
  if (MOCK_MODE) {
    const mockRows = [
      {
        sessionId: "sess-mock-001",
        userId: "user-mock-001",
        username: "discord-nebula",
        userDisplay: "discord-nebula [user-mock-001]",
        status: "WARN",
        decisionReasonCode: "LLM_LINK_ACTIVITY_DETECTED",
        llmCount: 3,
        latestDomain: "chat.openai.com",
        latestTime: new Date().toISOString(),
        llmLink: "https://chat.openai.com",
        cliDetected: true,
        cliReasonCount: 2,
        usageClass: "MIXED",
        confidence: 92,
        cGuardOn: true,
        lastHeartbeatAt: new Date().toISOString(),
        banDisabled: false
      },
      {
        sessionId: "sess-mock-002",
        userId: "user-mock-002",
        username: "discord-quiet",
        userDisplay: "discord-quiet [user-mock-002]",
        status: "ACTIVE",
        decisionReasonCode: "",
        llmCount: 0,
        latestDomain: "",
        latestTime: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
        llmLink: "",
        cliDetected: false,
        cliReasonCount: 0,
        usageClass: "UNKNOWN",
        confidence: 10,
        cGuardOn: true,
        lastHeartbeatAt: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
        banDisabled: false
      },
      {
        sessionId: "sess-mock-003",
        userId: "user-mock-003",
        username: "discord-off-guard",
        userDisplay: "discord-off-guard [user-mock-003]",
        status: "BLOCKED",
        decisionReasonCode: "KERNEL_CONNECTION_REQUIRED",
        llmCount: 1,
        latestDomain: "claude.ai",
        latestTime: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
        llmLink: "https://claude.ai",
        cliDetected: false,
        cliReasonCount: 0,
        usageClass: "WEB",
        confidence: 66,
        cGuardOn: false,
        lastHeartbeatAt: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
        banDisabled: true
      }
    ];
    state.rows = mockRows;
    setAuthState("MOCK MODE: login is bypassed.");
    setViewState("Rendering mock rows for UI preview.");
    renderSummary(mockRows);
    renderRows(applyViewFilter(mockRows));
    dom.reloadBtn.disabled = true;
    dom.llmAuthForm.querySelectorAll("input,button").forEach((node) => {
      node.disabled = true;
    });
    return;
  }

  const stored = readAuthFromStorage();
  if (stored && stored.token) {
    state.token = stored.token;
    state.adminKey = stored.adminKey || "";
    dom.adminKeyInput.value = state.adminKey;
    setAuthState("Authenticated from current browser session.");
    void (async () => {
      await loadRuntimeLlmMonitorPolicy();
      await loadLlmSessions();
    })();
    startAutoRefreshIfNeeded();
    return;
  }
  setAuthState("Not authenticated.");
  setViewState("Login first, then load sessions.");
}

init();
  const statusReasonCodes =
    sessionSummary &&
    Array.isArray(sessionSummary.status_reason_codes)
      ? sessionSummary.status_reason_codes
      : [];
  const rootReasonCode =
    statusReasonCodes.length > 0
      ? statusReasonCodes[0]
      : session.decision_reason_code || discordIdentityPolicyReasonCode || "";
