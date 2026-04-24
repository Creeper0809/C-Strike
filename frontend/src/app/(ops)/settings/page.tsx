"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Save, Loader2, Bot, CheckCircle2 } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/ui/PageHeader";

/* ─── 타입 ────────────────────────────────────────────── */

interface ConfigItem {
  key: string;
  value: unknown;
}

type ConfigMap = Record<string, unknown>;

type ExportFormat = "csv" | "json";

/* ─── 디스코드 봇 설정 타입 ──────────────────────────── */

// 운영진 역할은 /operators 페이지에서 Discord 사용자 ID 지정 시 봇이 자동 생성/부여함 (UI 중복 제거)
interface DiscordBotConfig {
  discord_bot_token: string;
  discord_guild_id: string;
  discord_announcement_channel_id: string;
  discord_emergency_channel_id: string;
  discord_ticket_channel_id: string;
  bot_api_base_url: string;
  bot_api_key: string;
}

interface DiscordFieldDef {
  key: keyof DiscordBotConfig;
  label: string;
  placeholder: string;
  sensitive: boolean;
}

const DISCORD_FIELDS: DiscordFieldDef[] = [
  {
    key: "discord_bot_token",
    label: "봇 토큰",
    placeholder: "디스코드 봇 토큰을 입력하세요",
    sensitive: true,
  },
  {
    key: "discord_guild_id",
    label: "서버(길드) ID",
    placeholder: "디스코드 서버 ID",
    sensitive: false,
  },
  {
    key: "discord_announcement_channel_id",
    label: "공지 채널 ID",
    placeholder: "공지사항 채널 ID",
    sensitive: false,
  },
  {
    key: "discord_emergency_channel_id",
    label: "비상 채널 ID",
    placeholder: "비상 알림 채널 ID",
    sensitive: false,
  },
  {
    key: "discord_ticket_channel_id",
    label: "티켓 채널 ID",
    placeholder: "티켓 채널 ID",
    sensitive: false,
  },
  {
    key: "bot_api_base_url",
    label: "봇 API URL",
    placeholder: "http://localhost:8400/api/v1/bot",
    sensitive: false,
  },
  {
    key: "bot_api_key",
    label: "봇 API 키",
    placeholder: "X-Bot-API-Key 인증 키",
    sensitive: true,
  },
];

const EMPTY_DISCORD_CONFIG: DiscordBotConfig = {
  discord_bot_token: "",
  discord_guild_id: "",
  discord_announcement_channel_id: "",
  discord_emergency_channel_id: "",
  discord_ticket_channel_id: "",
  bot_api_base_url: "",
  bot_api_key: "",
};

/* ─── 설정 키 → 섹션/라벨 매핑 ───────────────────────── */

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "datetime-local" | "checkbox";
}

interface SectionDef {
  title: string;
  fields: FieldDef[];
}

const SECTIONS: SectionDef[] = [
  {
    title: "채점 설정",
    fields: [
      {
        key: "scoring.round_interval_seconds",
        label: "동적 플래그 재생성 간격 (초)",
        type: "number",
      },
    ],
  },
];

/* ─── 메인 페이지 ─────────────────────────────────────── */

export default function SettingsPage() {
  const [config, setConfig] = useState<ConfigMap>({});
  const [original, setOriginal] = useState<ConfigMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  /* ── 디스코드 봇 설정 상태 ─────────────────────────── */
  const [discordConfig, setDiscordConfig] = useState<DiscordBotConfig>({ ...EMPTY_DISCORD_CONFIG });
  const [discordOriginal, setDiscordOriginal] = useState<DiscordBotConfig>({ ...EMPTY_DISCORD_CONFIG });
  const [isDiscordSaving, setIsDiscordSaving] = useState(false);
  const [discordSaveMsg, setDiscordSaveMsg] = useState("");

  /* ── 데이터 페칭 ─────────────────────────────────────── */

  const fetchSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const items = await apiFetch<ConfigItem[]>("/settings/");
      const map: ConfigMap = {};
      for (const item of items) {
        map[item.key] = item.value;
      }
      setConfig(map);
      setOriginal(map);
    } catch {
      setConfig({});
      setOriginal({});
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchDiscordConfig = useCallback(async () => {
    try {
      const data = await apiFetch<DiscordBotConfig>("/settings/discord");
      setDiscordConfig(data);
      setDiscordOriginal(data);
    } catch {
      setDiscordConfig({ ...EMPTY_DISCORD_CONFIG });
      setDiscordOriginal({ ...EMPTY_DISCORD_CONFIG });
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchDiscordConfig();
  }, [fetchSettings, fetchDiscordConfig]);

  /* ── 변경 감지 ──────────────────────────────────────── */

  const hasChanges = Object.keys(config).some(
    (k) => config[k] !== original[k],
  );

  const hasDiscordChanges = DISCORD_FIELDS.some(
    (f) => discordConfig[f.key] !== discordOriginal[f.key],
  );

  /* ── 값 변경 핸들러 ─────────────────────────────────── */

  function updateField(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function updateDiscordField(key: keyof DiscordBotConfig, value: string) {
    setDiscordConfig((prev) => ({ ...prev, [key]: value }));
  }

  /* ── 저장 ───────────────────────────────────────────── */

  async function handleSave() {
    if (!hasChanges) return;

    const updates: Record<string, unknown> = {};
    for (const key of Object.keys(config)) {
      if (config[key] !== original[key]) {
        updates[key] = config[key];
      }
    }

    setIsSaving(true);
    try {
      await apiFetch("/settings/", {
        method: "PATCH",
        body: JSON.stringify({ updates }),
      });
      setOriginal({ ...config });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDiscordSave() {
    if (!hasDiscordChanges) return;

    // 변경된 필드만 전송 (마스킹된 값은 제외)
    const payload: Record<string, string> = {};
    for (const f of DISCORD_FIELDS) {
      const val = discordConfig[f.key];
      const orig = discordOriginal[f.key];
      if (val !== orig && !val.includes("...") && val !== "••••••••") {
        payload[f.key] = val;
      }
    }

    if (Object.keys(payload).length === 0) return;

    setIsDiscordSaving(true);
    setDiscordSaveMsg("");
    try {
      const updated = await apiFetch<DiscordBotConfig>("/settings/discord", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setDiscordConfig(updated);
      setDiscordOriginal(updated);
      setDiscordSaveMsg("설정이 저장되었습니다. 봇에 실시간으로 반영됩니다.");
      setTimeout(() => setDiscordSaveMsg(""), 5000);
    } catch {
      setDiscordSaveMsg("저장에 실패했습니다. 다시 시도해주세요.");
      setTimeout(() => setDiscordSaveMsg(""), 5000);
    } finally {
      setIsDiscordSaving(false);
    }
  }

  /* ── 내보내기 ───────────────────────────────────────── */

  function handleExport(format: ExportFormat) {
    window.open(
      `/api/settings/export/results?format=${format}`,
      "_blank",
    );
  }

  /* ── 렌더링 ─────────────────────────────────────────── */

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="운영 설정"
          description="admin 전용"
        />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <PageHeader
        title="운영 설정"
        description="admin 전용"
        actions={
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white transition-colors",
              hasChanges && !isSaving
                ? "hover:bg-accent/80"
                : "opacity-50 cursor-not-allowed",
            )}
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isSaving ? "저장 중..." : "저장"}
          </button>
        }
      />

      {/* 설정 섹션 */}
      <div className="space-y-5">
        {SECTIONS.map((section) => (
          <section
            key={section.title}
            className="bg-bg-secondary rounded-xl p-5 border border-border space-y-4"
          >
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              {section.title}
            </h2>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.fields.map((field) => (
                <SettingsField
                  key={field.key}
                  field={field}
                  value={config[field.key]}
                  onChange={(v) => updateField(field.key, v)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* 디스코드 봇 설정 */}
      <section className="bg-bg-secondary rounded-xl p-5 border border-border space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Bot className="w-4 h-4 text-[#5865F2]" />
            디스코드 봇 설정
          </h2>
          <button
            type="button"
            onClick={handleDiscordSave}
            disabled={!hasDiscordChanges || isDiscordSaving}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white transition-colors",
              hasDiscordChanges && !isDiscordSaving
                ? "hover:bg-accent/80"
                : "opacity-50 cursor-not-allowed",
            )}
          >
            {isDiscordSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isDiscordSaving ? "저장 중..." : "설정 저장"}
          </button>
        </div>

        {discordSaveMsg && (
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-lg",
              discordSaveMsg.includes("실패")
                ? "bg-status-danger/10 text-status-danger"
                : "bg-status-success/10 text-status-success",
            )}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {discordSaveMsg}
          </div>
        )}

        <p className="text-xs text-text-muted">
          디스코드 봇의 토큰, 채널 ID, API 설정을 관리합니다. 변경 사항은 Redis를 통해 봇에 실시간으로 반영됩니다.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          {DISCORD_FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="text-sm text-text-secondary">{field.label}</span>
              <input
                type={field.sensitive ? "password" : "text"}
                value={discordConfig[field.key]}
                placeholder={field.placeholder}
                onChange={(e) => updateDiscordField(field.key, e.target.value)}
                className="mt-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
              />
            </label>
          ))}
        </div>
      </section>

      {/* 결과 내보내기 패널 */}
      <section className="bg-bg-secondary rounded-xl p-5 border border-border space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">
          결과 데이터 내보내기 (결과보고서용)
        </h2>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => handleExport("csv")}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
          >
            <Download className="w-4 h-4" />
            CSV 다운로드
          </button>
          <button
            type="button"
            onClick={() => handleExport("json")}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
          >
            <Download className="w-4 h-4" />
            JSON 다운로드
          </button>
        </div>
      </section>
    </div>
  );
}

/* ─── 설정 필드 컴포넌트 ──────────────────────────────── */

function SettingsField({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const baseInputClass =
    "bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full";

  /* 체크박스 */
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-bg-tertiary"
        />
        <span className="text-sm text-text-secondary">{field.label}</span>
      </label>
    );
  }

  /* 텍스트 / 숫자 / datetime-local */
  return (
    <label className="block">
      <span className="text-sm text-text-secondary">{field.label}</span>
      <input
        type={field.type}
        value={value != null ? String(value) : ""}
        onChange={(e) => {
          const v =
            field.type === "number"
              ? e.target.value === "" ? "" : Number(e.target.value)
              : e.target.value;
          onChange(v);
        }}
        className={cn("mt-1", baseInputClass)}
      />
    </label>
  );
}
