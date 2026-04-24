const { createApp } = require("./httpServer");

const port = Number(process.env.PORT || 8080);

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const app = createApp({
  stateMode: process.env.STATE_MODE || "memory",
  postgresConnectionString:
    process.env.STATE_PG_CONNECTION_STRING || process.env.DATABASE_URL || "",
  postgresSchema: process.env.STATE_PG_SCHEMA || "cstrike",
  postgresPsqlBin: process.env.STATE_PG_PSQL_BIN || "psql",
  postgresDdlPath: process.env.STATE_PG_DDL_PATH || "",
  postgresStatementTimeoutMs: Number(process.env.STATE_PG_STATEMENT_TIMEOUT_MS || 5000),
  adminApiKey: process.env.ADMIN_API_KEY || null,
  adminSigningSecret: process.env.ADMIN_SIGNING_SECRET || "dev-admin-signing-secret",
  adminTokenTtlSec: Number(process.env.ADMIN_TOKEN_TTL_SEC || 60 * 60 * 4),
  integrationPublicBaseUrl: process.env.INTEGRATION_PUBLIC_BASE_URL || "",
  integrationDiscordIdentityAuthorizationUrlTemplate:
    process.env.INTEGRATION_DISCORD_IDENTITY_AUTH_URL_TEMPLATE || "",
  kernelIntegrity: {
    maxKernelSignalsPerBatch: normalizePositiveInteger(
      process.env.ANTILLM_MAX_KERNEL_SIGNALS_PER_BATCH,
      5
    ),
    maxBridgeEmitDeltaMs: normalizePositiveInteger(
      process.env.ANTILLM_MAX_BRIDGE_EMIT_DELTA_MS,
      60 * 1000
    ),
    warnAction: process.env.ANTILLM_KERNEL_WARN_ACTION || "monitor"
  },
  llmMonitor: {
    cliDetectionAction:
      process.env.CGUARD_CLI_DETECTION_ACTION ||
      process.env.ANTILLM_CLI_DETECTION_ACTION ||
      "blocked",
    cliConfidenceThreshold: Number(
      process.env.CGUARD_CLI_CONFIDENCE_THRESHOLD ||
        process.env.ANTILLM_CLI_CONFIDENCE_THRESHOLD ||
        85
    )
  },
  // Integration API 활성화 (운영포털 연동용)
  // 외주 start.js에 주입 누락으로 기본값 false 고정되던 문제 대응
  // 외주 문서(docs/integration_fallback_scenario_matrix.md)에 ANTILLM_INTEGRATION_API_ENABLED env 언급되나 실제 코드엔 처리 없음
  integrationApi: {
    enabled: process.env.INTEGRATION_API_ENABLED === "true",
    token: process.env.CGUARD_INTEGRATION_TOKEN || undefined,
    apiKey: process.env.CGUARD_INTEGRATION_API_KEY || null
  }
});

app.server.listen(port, () => {
  // Keep startup output minimal and machine-friendly.
  process.stdout.write(`antiLLM server listening on :${port}\n`);
});
