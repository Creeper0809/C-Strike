"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Save, Loader2, Bot, CheckCircle2 } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/ui/PageHeader";
import type { Competition, CompetitionListItem, CompetitionListResponse } from "@/types/ops";

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

const COMPETITION_STATUS_PRIORITY = [
  "running",
  "paused",
  "ready",
  "registration",
  "draft",
  "finished",
  "archived",
] as const;

interface CompetitionScheduleForm {
  name: string;
  scheduled_start_year: string;
  scheduled_start_month: string;
  scheduled_start_day: string;
  scheduled_start_hour: string;
  scheduled_start_minute: string;
  scheduled_end_year: string;
  scheduled_end_month: string;
  scheduled_end_day: string;
  scheduled_end_hour: string;
  scheduled_end_minute: string;
  scoring_round_interval_seconds: number | "";
}

const EMPTY_COMPETITION_FORM: CompetitionScheduleForm = {
  name: "",
  scheduled_start_year: "",
  scheduled_start_month: "",
  scheduled_start_day: "",
  scheduled_start_hour: "",
  scheduled_start_minute: "",
  scheduled_end_year: "",
  scheduled_end_month: "",
  scheduled_end_day: "",
  scheduled_end_hour: "",
  scheduled_end_minute: "",
  scoring_round_interval_seconds: "",
};

function splitDatetimeValue(
  value: string | null | undefined,
): { year: string; month: string; day: string; hour: string; minute: string } {
  if (!value) return { year: "", month: "", day: "", hour: "", minute: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { year: "", month: "", day: "", hour: "", minute: "" };
  }
  const pad = (num: number) => String(num).padStart(2, "0");
  return {
    year: String(date.getFullYear()),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    hour: pad(date.getHours()),
    minute: pad(date.getMinutes()),
  };
}

function toIsoDatetime(
  yearValue: string,
  monthValue: string,
  dayValue: string,
  hourValue: string,
  minuteValue: string,
): string | null {
  if (!yearValue || !monthValue || !dayValue) return null;
  const normalizedHour = hourValue || "00";
  const normalizedMinute = minuteValue || "00";
  const combined = `${yearValue}-${monthValue}-${dayValue}T${normalizedHour}:${normalizedMinute}`;
  const date = new Date(combined);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

const CURRENT_YEAR = new Date().getUTCFullYear();
const YEAR_OPTIONS = Array.from({ length: 11 }, (_, index) =>
  String(CURRENT_YEAR - 2 + index),
);
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);
const DAY_OPTIONS = Array.from({ length: 31 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) =>
  String(index).padStart(2, "0"),
);

const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) =>
  String(index).padStart(2, "0"),
);

function pickPreferredCompetitionId(items: CompetitionListItem[]): string {
  for (const status of COMPETITION_STATUS_PRIORITY) {
    const match = items.find((item) => item.status === status);
    if (match) return match.id;
  }
  return items[0]?.id ?? "";
}

function toCompetitionForm(comp: Competition | null): CompetitionScheduleForm {
  if (!comp) return { ...EMPTY_COMPETITION_FORM };
  const start = splitDatetimeValue(comp.scheduled_start_at);
  const end = splitDatetimeValue(comp.scheduled_end_at);
  return {
    name: comp.name,
    scheduled_start_year: start.year,
    scheduled_start_month: start.month,
    scheduled_start_day: start.day,
    scheduled_start_hour: start.hour,
    scheduled_start_minute: start.minute,
    scheduled_end_year: end.year,
    scheduled_end_month: end.month,
    scheduled_end_day: end.day,
    scheduled_end_hour: end.hour,
    scheduled_end_minute: end.minute,
    scoring_round_interval_seconds: comp.scoring_round_interval_seconds,
  };
}

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
  const [competitions, setCompetitions] = useState<CompetitionListItem[]>([]);
  const [selectedCompetitionId, setSelectedCompetitionId] = useState("");
  const [selectedCompetition, setSelectedCompetition] = useState<Competition | null>(null);
  const [competitionForm, setCompetitionForm] = useState<CompetitionScheduleForm>({ ...EMPTY_COMPETITION_FORM });
  const [competitionOriginal, setCompetitionOriginal] = useState<CompetitionScheduleForm>({ ...EMPTY_COMPETITION_FORM });
  const [isCompetitionLoading, setIsCompetitionLoading] = useState(false);
  const [isCompetitionSaving, setIsCompetitionSaving] = useState(false);
  const [competitionSaveMsg, setCompetitionSaveMsg] = useState("");

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

  const fetchCompetitions = useCallback(async () => {
    try {
      const response = await apiFetch<CompetitionListResponse>("/v1/competitions/?page=1&size=100");
      const items = response.items ?? [];
      setCompetitions(items);
      setSelectedCompetitionId((prev) => {
        if (prev && items.some((item) => item.id === prev)) return prev;
        return pickPreferredCompetitionId(items);
      });
    } catch {
      setCompetitions([]);
      setSelectedCompetitionId("");
      setSelectedCompetition(null);
      setCompetitionForm({ ...EMPTY_COMPETITION_FORM });
      setCompetitionOriginal({ ...EMPTY_COMPETITION_FORM });
    }
  }, []);

  const fetchCompetitionDetail = useCallback(async (competitionId: string) => {
    if (!competitionId) {
      setSelectedCompetition(null);
      setCompetitionForm({ ...EMPTY_COMPETITION_FORM });
      setCompetitionOriginal({ ...EMPTY_COMPETITION_FORM });
      return;
    }
    setIsCompetitionLoading(true);
    try {
      const comp = await apiFetch<Competition>(`/v1/competitions/${competitionId}`);
      const form = toCompetitionForm(comp);
      setSelectedCompetition(comp);
      setCompetitionForm(form);
      setCompetitionOriginal(form);
    } catch {
      setSelectedCompetition(null);
      setCompetitionForm({ ...EMPTY_COMPETITION_FORM });
      setCompetitionOriginal({ ...EMPTY_COMPETITION_FORM });
    } finally {
      setIsCompetitionLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchDiscordConfig();
    fetchCompetitions();
  }, [fetchSettings, fetchDiscordConfig, fetchCompetitions]);

  useEffect(() => {
    void fetchCompetitionDetail(selectedCompetitionId);
  }, [fetchCompetitionDetail, selectedCompetitionId]);

  /* ── 변경 감지 ──────────────────────────────────────── */

  const hasChanges = Object.keys(config).some(
    (k) => config[k] !== original[k],
  );

  const hasDiscordChanges = DISCORD_FIELDS.some(
    (f) => discordConfig[f.key] !== discordOriginal[f.key],
  );

  const hasCompetitionChanges =
    competitionForm.name !== competitionOriginal.name ||
    competitionForm.scheduled_start_year !== competitionOriginal.scheduled_start_year ||
    competitionForm.scheduled_start_month !== competitionOriginal.scheduled_start_month ||
    competitionForm.scheduled_start_day !== competitionOriginal.scheduled_start_day ||
    competitionForm.scheduled_start_hour !== competitionOriginal.scheduled_start_hour ||
    competitionForm.scheduled_start_minute !== competitionOriginal.scheduled_start_minute ||
    competitionForm.scheduled_end_year !== competitionOriginal.scheduled_end_year ||
    competitionForm.scheduled_end_month !== competitionOriginal.scheduled_end_month ||
    competitionForm.scheduled_end_day !== competitionOriginal.scheduled_end_day ||
    competitionForm.scheduled_end_hour !== competitionOriginal.scheduled_end_hour ||
    competitionForm.scheduled_end_minute !== competitionOriginal.scheduled_end_minute ||
    competitionForm.scoring_round_interval_seconds !== competitionOriginal.scoring_round_interval_seconds;

  /* ── 값 변경 핸들러 ─────────────────────────────────── */

  function updateField(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function updateDiscordField(key: keyof DiscordBotConfig, value: string) {
    setDiscordConfig((prev) => ({ ...prev, [key]: value }));
  }

  function updateCompetitionField<K extends keyof CompetitionScheduleForm>(
    key: K,
    value: CompetitionScheduleForm[K],
  ) {
    setCompetitionForm((prev) => ({ ...prev, [key]: value }));
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

  async function handleCompetitionSave() {
    if (!selectedCompetitionId || !hasCompetitionChanges) return;

    setIsCompetitionSaving(true);
    setCompetitionSaveMsg("");
    try {
      const payload = {
        name: competitionForm.name.trim(),
        scheduled_start_at: toIsoDatetime(
          competitionForm.scheduled_start_year,
          competitionForm.scheduled_start_month,
          competitionForm.scheduled_start_day,
          competitionForm.scheduled_start_hour,
          competitionForm.scheduled_start_minute,
        ),
        scheduled_end_at: toIsoDatetime(
          competitionForm.scheduled_end_year,
          competitionForm.scheduled_end_month,
          competitionForm.scheduled_end_day,
          competitionForm.scheduled_end_hour,
          competitionForm.scheduled_end_minute,
        ),
        scoring_round_interval_seconds: Number(competitionForm.scoring_round_interval_seconds || 120),
      };
      const updated = await apiFetch<Competition>(`/v1/competitions/${selectedCompetitionId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const form = toCompetitionForm(updated);
      setSelectedCompetition(updated);
      setCompetitionForm(form);
      setCompetitionOriginal(form);
      setCompetitionSaveMsg("대회 기간과 라운드 간격이 저장되었습니다.");
      setCompetitions((prev) =>
        prev.map((item) =>
          item.id === updated.id
            ? {
                ...item,
                name: updated.name,
                status: updated.status,
                scheduled_start_at: updated.scheduled_start_at,
                scheduled_end_at: updated.scheduled_end_at,
              }
            : item,
        ),
      );
    } catch (error) {
      setCompetitionSaveMsg(error instanceof Error ? error.message : "대회 기간 저장에 실패했습니다.");
    } finally {
      setIsCompetitionSaving(false);
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

      <section className="bg-bg-secondary rounded-xl p-5 border border-border space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-text-primary">대회 기간 설정</h2>
            <p className="text-xs text-text-muted">
              현재 대회의 이름과 기간을 관리합니다. 이 시간 밖에서는 참가자용 `/문제목록`, `/문제`, `/flag`가 차단되고 채점 라운드도 진행되지 않습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCompetitionSave}
            disabled={!selectedCompetitionId || !hasCompetitionChanges || isCompetitionSaving}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white transition-colors",
              selectedCompetitionId && hasCompetitionChanges && !isCompetitionSaving
                ? "hover:bg-accent/80"
                : "opacity-50 cursor-not-allowed",
            )}
          >
            {isCompetitionSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isCompetitionSaving ? "저장 중..." : "대회 기간 저장"}
          </button>
        </div>

        {competitionSaveMsg && (
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-lg",
              competitionSaveMsg.includes("실패") || competitionSaveMsg.includes("없") || competitionSaveMsg.includes("이전")
                ? "bg-status-danger/10 text-status-danger"
                : "bg-status-success/10 text-status-success",
            )}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {competitionSaveMsg}
          </div>
        )}

        {competitions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
            설정할 대회가 없습니다. 대회를 먼저 생성해 주세요.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="block">
              <span className="text-sm text-text-secondary">현재 대회</span>
              <input
                type="text"
                value={competitionForm.name}
                onChange={(e) => updateCompetitionField("name", e.target.value)}
                disabled={isCompetitionLoading}
                className="mt-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                placeholder="대회 이름"
              />
            </label>

            <label className="block">
              <span className="text-sm text-text-secondary">현재 상태</span>
              <input
                type="text"
                value={selectedCompetition?.status ?? ""}
                readOnly
                className="mt-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary w-full"
              />
            </label>

            <div className="block">
              <span className="text-sm text-text-secondary">예정 시작 시각</span>
              <div className="mt-1 grid grid-cols-5 gap-2">
                <select
                  value={competitionForm.scheduled_start_year}
                  onChange={(e) => updateCompetitionField("scheduled_start_year", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">년</option>
                  {YEAR_OPTIONS.map((year) => (
                    <option key={year} value={year}>
                      {year}년
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_start_month}
                  onChange={(e) => updateCompetitionField("scheduled_start_month", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">월</option>
                  {MONTH_OPTIONS.map((month) => (
                    <option key={month} value={month}>
                      {month}월
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_start_day}
                  onChange={(e) => updateCompetitionField("scheduled_start_day", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">일</option>
                  {DAY_OPTIONS.map((day) => (
                    <option key={day} value={day}>
                      {day}일
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_start_hour}
                  onChange={(e) => updateCompetitionField("scheduled_start_hour", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">시</option>
                  {HOUR_OPTIONS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hour}시
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_start_minute}
                  onChange={(e) => updateCompetitionField("scheduled_start_minute", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">분</option>
                  {MINUTE_OPTIONS.map((minute) => (
                    <option key={minute} value={minute}>
                      {minute}분
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="block">
              <span className="text-sm text-text-secondary">예정 종료 시각</span>
              <div className="mt-1 grid grid-cols-5 gap-2">
                <select
                  value={competitionForm.scheduled_end_year}
                  onChange={(e) => updateCompetitionField("scheduled_end_year", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">년</option>
                  {YEAR_OPTIONS.map((year) => (
                    <option key={year} value={year}>
                      {year}년
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_end_month}
                  onChange={(e) => updateCompetitionField("scheduled_end_month", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">월</option>
                  {MONTH_OPTIONS.map((month) => (
                    <option key={month} value={month}>
                      {month}월
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_end_day}
                  onChange={(e) => updateCompetitionField("scheduled_end_day", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">일</option>
                  {DAY_OPTIONS.map((day) => (
                    <option key={day} value={day}>
                      {day}일
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_end_hour}
                  onChange={(e) => updateCompetitionField("scheduled_end_hour", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">시</option>
                  {HOUR_OPTIONS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hour}시
                    </option>
                  ))}
                </select>
                <select
                  value={competitionForm.scheduled_end_minute}
                  onChange={(e) => updateCompetitionField("scheduled_end_minute", e.target.value)}
                  disabled={isCompetitionLoading}
                  className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
                >
                  <option value="">분</option>
                  {MINUTE_OPTIONS.map((minute) => (
                    <option key={minute} value={minute}>
                      {minute}분
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="block">
              <span className="text-sm text-text-secondary">라운드 간격 (초)</span>
              <input
                type="number"
                min={1}
                value={competitionForm.scoring_round_interval_seconds}
                onChange={(e) => updateCompetitionField("scoring_round_interval_seconds", e.target.value === "" ? "" : Number(e.target.value))}
                disabled={isCompetitionLoading}
                className="mt-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent w-full"
              />
            </label>
          </div>
        )}
      </section>

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
