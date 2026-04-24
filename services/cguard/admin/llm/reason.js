"use strict";

const CLI_HINTS = Object.freeze([
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

const AUTH_STORAGE_KEY = "antillm_llm_admin_auth_v1";
const MOCK_MODE = new URLSearchParams(window.location.search || "").get("mock") === "1";

const state = {
  token: "",
  adminKey: "",
  sessionId: "",
  summary: null
};

const dom = {
  reasonAuthForm: document.getElementById("reasonAuthForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  adminKeyInput: document.getElementById("adminKeyInput"),
  reloadBtn: document.getElementById("reloadBtn"),
  authState: document.getElementById("authState"),
  viewState: document.getElementById("viewState"),
  summaryGrid: document.getElementById("summaryGrid"),
  reasonRowsBody: document.getElementById("reasonRowsBody")
};

function setAuthState(message) {
  dom.authState.textContent = message;
}

function setViewState(message) {
  dom.viewState.textContent = message;
}

function readSessionId() {
  const params = new URLSearchParams(window.location.search || "");
  return params.get("session_id") || "";
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

function writeAuthToStorage() {
  const payload = {
    token: state.token || "",
    adminKey: state.adminKey || ""
  };
  window.sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(payload));
}

function formatDate(value) {
  if (!value) return "-";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

function extractEvidenceStrings(item) {
  const bag = [];
  const evidence = item && item.evidence && typeof item.evidence === "object" ? item.evidence : {};
  const processValue = normalizeText(item && item.process);
  if (processValue) bag.push(processValue);

  const directKeys = ["command_line", "executable_path", "process_name", "description", "remote_host"];
  for (const key of directKeys) {
    const normalized = normalizeText(evidence[key]);
    if (normalized) bag.push(normalized);
  }

  const matches = Array.isArray(evidence.matches) ? evidence.matches : [];
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
    const matchedHint = CLI_HINTS.find((hint) => strings.some((text) => text.includes(hint)));
    if (!matchedHint) continue;
    const key = `${event.event_type || "unknown"}|${event.timestamp || ""}|${matchedHint}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    reasons.push({
      timestamp: event.timestamp || null,
      event_type: event.event_type || "unknown",
      matched_hint: matchedHint,
      process: event.process || null,
      command_line:
        event && event.evidence && typeof event.evidence === "object"
          ? event.evidence.command_line || "-"
          : "-"
    });
  }

  return reasons;
}

function renderSummary(summary, cliReasons) {
  dom.summaryGrid.innerHTML = "";
  const rows = [
    ["session_id", summary && summary.session_id],
    ["username", summary && summary.username],
    ["user_id", summary && summary.user_id],
    ["status", summary && summary.current_status],
    ["decision_reason_code", summary && summary.decision_reason_code],
    ["client_version", summary && summary.client_version],
    [
      "c_guard",
      summary &&
      summary.client_agent_state === "running" &&
      summary.kernel_bridge_state === "connected" &&
      summary.kernel_driver_loaded === true
        ? "ON"
        : "OFF"
    ],
    ["cli_detected", cliReasons.length > 0 ? "yes" : "no"],
    ["cli_reason_count", String(cliReasons.length)]
  ];

  for (const [label, value] of rows) {
    const node = document.createElement("div");
    node.className = "summary-item";
    node.innerHTML = `<span class="label">${label}</span><span class="value">${value || "-"}</span>`;
    dom.summaryGrid.appendChild(node);
  }
}

function renderReasonRows(rows) {
  dom.reasonRowsBody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "empty";
    td.colSpan = 5;
    td.textContent = "No CLI evidence found for current session.";
    tr.appendChild(td);
    dom.reasonRowsBody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.classList.add("hit");
    tr.innerHTML = `
      <td>${formatDate(row.timestamp)}</td>
      <td>${row.event_type}</td>
      <td><code>${row.matched_hint}</code></td>
      <td>${row.process || "-"}</td>
      <td><code>${row.command_line || "-"}</code></td>
    `;
    dom.reasonRowsBody.appendChild(tr);
  }
}

async function loadReasonDetail() {
  if (!state.token) {
    setViewState("Login first.");
    return;
  }
  if (!state.sessionId) {
    setViewState("Missing session_id query parameter.");
    return;
  }
  setViewState(`Loading session ${state.sessionId} ...`);

  try {
    const sid = encodeURIComponent(state.sessionId);
    const summaryPayload = await fetchJson(`/v1/admin/session-summary/${sid}`);
    const investigationPayload = await fetchJson(`/v1/admin/investigation/${sid}?collapse_noisy=1`);
    const timeline = Array.isArray(investigationPayload.event_timeline)
      ? investigationPayload.event_timeline
      : [];
    const cliReasons = detectCliSignals(timeline);
    const summary = summaryPayload && summaryPayload.session ? summaryPayload.session : {};
    state.summary = summary;
    renderSummary(summary, cliReasons);
    renderReasonRows(cliReasons);
    setViewState(`Loaded evidence rows: ${cliReasons.length}`);
  } catch (error) {
    setViewState(`Failed to load reason detail: ${error.message}`);
    renderSummary({}, []);
    renderReasonRows([]);
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
    await loadReasonDetail();
  } catch (error) {
    state.token = "";
    setAuthState(`Auth failed: ${error.message}`);
    setViewState("Login failed.");
  }
}

function bindEvents() {
  dom.reasonAuthForm.addEventListener("submit", onLogin);
  dom.reloadBtn.addEventListener("click", () => {
    void loadReasonDetail();
  });
}

function init() {
  state.sessionId = readSessionId();
  bindEvents();

  if (MOCK_MODE) {
    const mockSummary = {
      session_id: state.sessionId || "sess-mock-001",
      username: "discord-nebula",
      user_id: "user-mock-001",
      current_status: "WARN",
      decision_reason_code: "LLM_LINK_ACTIVITY_DETECTED",
      client_version: "1.4.0",
      client_agent_state: "running",
      kernel_bridge_state: "connected",
      kernel_driver_loaded: true
    };
    const mockReasons = [
      {
        timestamp: new Date().toISOString(),
        event_type: "PROCESS_POLICY_MATCH",
        matched_hint: "codex",
        process: "codex.exe",
        command_line: "codex --prompt \"solve this ctf challenge\""
      },
      {
        timestamp: new Date(Date.now() - 120000).toISOString(),
        event_type: "PROCESS_POLICY_MATCH",
        matched_hint: "openai",
        process: "python.exe",
        command_line: "python helper.py --provider openai --model gpt-4.1"
      }
    ];
    renderSummary(mockSummary, mockReasons);
    renderReasonRows(mockReasons);
    setAuthState("MOCK MODE: login is bypassed.");
    setViewState(`Loaded mock evidence rows: ${mockReasons.length}`);
    dom.reasonAuthForm.querySelectorAll("input,button").forEach((node) => {
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
    void loadReasonDetail();
    return;
  }
  setAuthState("Not authenticated.");
  setViewState(state.sessionId ? "Login first." : "Missing session_id query parameter.");
}

init();
