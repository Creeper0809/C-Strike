"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, FileText, Megaphone, Radio, RefreshCw, Shield } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  DISCORD_BOT_STATUS_MAP,
  DISCORD_LOG_TYPE_MAP,
  DISCORD_BROADCAST_KIND_MAP,
  DISCORD_BROADCAST_STATUS_MAP,
  STATUS_COLORS,
} from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import type {
  DiscordBotSummary,
  DiscordBotEvent,
  DiscordBotBroadcast,
  DiscordBotRelay,
  DiscordBotCGuardEvent,
} from "@/types/ops";

/* ─── 상수 ────────────────────────────────────────────── */

const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 30_000;

type TabKey = "events" | "broadcasts" | "relays" | "cguard";

const TABS: { key: TabKey; label: string }[] = [
  { key: "events", label: "이벤트 로그" },
  { key: "broadcasts", label: "공지 발송" },
  { key: "relays", label: "릴레이 이력" },
  { key: "cguard", label: "C-가드 인증" },
];

const LOG_TYPE_FILTER_OPTIONS = [
  { value: "", label: "전체" },
  { value: "command", label: "명령" },
  { value: "interaction", label: "상호작용" },
  { value: "member_join", label: "입장" },
  { value: "member_leave", label: "퇴장" },
  { value: "role_update", label: "역할 변경" },
  { value: "error", label: "오류" },
  { value: "system", label: "시스템" },
];

const BROADCAST_KIND_FILTER_OPTIONS = [
  { value: "", label: "전체" },
  { value: "announcement", label: "공지" },
  { value: "alert", label: "경보" },
  { value: "notice", label: "안내" },
  { value: "scoring", label: "채점" },
  { value: "emergency", label: "비상" },
];

/* ─── 유틸 ────────────────────────────────────────────── */

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function truncate(value: string | null | undefined, max = 80): string {
  if (!value) return "-";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function StatusBadge({
  value,
  map,
}: {
  value: string;
  map: Record<string, { label: string; color: keyof typeof STATUS_COLORS }>;
}) {
  const entry = map[value];
  if (!entry) {
    return <span className="text-xs text-text-muted font-mono">{value}</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
        STATUS_COLORS[entry.color],
        entry.color === "ok" && "bg-status-ok/10",
        entry.color === "warning" && "bg-status-warning/10",
        entry.color === "danger" && "bg-status-danger/10",
        entry.color === "info" && "bg-status-info/10",
        entry.color === "neutral" && "bg-bg-tertiary",
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          entry.color === "ok" && "bg-status-ok",
          entry.color === "warning" && "bg-status-warning",
          entry.color === "danger" && "bg-status-danger",
          entry.color === "info" && "bg-status-info",
          entry.color === "neutral" && "bg-status-neutral",
        )}
      />
      {entry.label}
    </span>
  );
}

/* ─── 요약 카드 ──────────────────────────────────────── */

interface SummaryCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
}

function SummaryCard({ label, value, sub, icon: Icon, color }: SummaryCardProps) {
  return (
    <div className="bg-bg-secondary border border-border rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary uppercase tracking-wider">
          {label}
        </span>
        <Icon className={cn("w-4 h-4", color)} />
      </div>
      <span className="text-3xl font-bold font-mono text-text-primary">
        {value}
      </span>
      {sub && (
        <span className="text-xs text-text-muted">{sub}</span>
      )}
    </div>
  );
}

/* ─── 페이지네이션 ───────────────────────────────────── */

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  const canPrev = page > 1;
  const canNext = page < totalPages;
  return (
    <div className="flex items-center justify-center gap-2 mt-4">
      <button
        type="button"
        disabled={!canPrev}
        onClick={() => onPageChange(page - 1)}
        className={cn(
          "px-3 py-1.5 text-sm rounded-lg transition-colors",
          canPrev
            ? "bg-bg-tertiary text-text-secondary hover:text-text-primary"
            : "text-text-muted cursor-not-allowed",
        )}
      >
        이전
      </button>
      <span className="text-sm text-text-secondary">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        disabled={!canNext}
        onClick={() => onPageChange(page + 1)}
        className={cn(
          "px-3 py-1.5 text-sm rounded-lg transition-colors",
          canNext
            ? "bg-bg-tertiary text-text-secondary hover:text-text-primary"
            : "text-text-muted cursor-not-allowed",
        )}
      >
        다음
      </button>
    </div>
  );
}

/* ─── 필터 셀렉트 ────────────────────────────────────── */

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="text-xs text-text-muted mb-1 block">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-1.5 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ─── 테이블 스켈레톤 ────────────────────────────────── */

function TableSkeleton({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={`skeleton-${i}`}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-4 w-3/4 animate-pulse rounded bg-bg-tertiary" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/* ─── 빈 상태 ────────────────────────────────────────── */

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td
        colSpan={cols}
        className="px-4 py-12 text-center text-sm text-text-muted"
      >
        데이터가 없습니다.
      </td>
    </tr>
  );
}

/* ─── 이벤트 로그 탭 ─────────────────────────────────── */

function EventsTab() {
  const [items, setItems] = useState<DiscordBotEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [logTypeFilter, setLogTypeFilter] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (logTypeFilter) params.set("log_type", logTypeFilter);
      const res = await apiFetch<{ items: DiscordBotEvent[]; total: number }>(
        `/discord-bot/events?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, logTypeFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const COLS = 6;

  return (
    <div>
      <div className="flex gap-3 items-end mb-4">
        <FilterSelect
          label="로그 유형"
          value={logTypeFilter}
          onChange={(v) => {
            setLogTypeFilter(v);
            setPage(1);
          }}
          options={LOG_TYPE_FILTER_OPTIONS}
        />
      </div>

      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">시간</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">로그 유형</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">이벤트 키</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">행위자</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">팀</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">상세 요약</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((e) => (
                <tr
                  key={String(e.event_id)}
                  className="transition-colors hover:bg-bg-tertiary/50"
                >
                  <td className="px-4 py-3 text-sm font-mono text-text-primary whitespace-nowrap">
                    {formatDateTime(e.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge value={e.log_type} map={DISCORD_LOG_TYPE_MAP} />
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-accent">
                    {e.event_key ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary">
                    {e.actor_username ?? e.actor_discord_id ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {e.team_name ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary max-w-[360px]">
                    <span className="block truncate" title={e.summary ?? undefined}>
                      {truncate(e.summary, 120)}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

/* ─── 공지 발송 탭 ───────────────────────────────────── */

function BroadcastsTab() {
  const [items, setItems] = useState<DiscordBotBroadcast[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (kindFilter) params.set("kind", kindFilter);
      const res = await apiFetch<{ items: DiscordBotBroadcast[]; total: number }>(
        `/discord-bot/broadcasts?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, kindFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const COLS = 6;

  return (
    <div>
      <div className="flex gap-3 items-end mb-4">
        <FilterSelect
          label="종류"
          value={kindFilter}
          onChange={(v) => {
            setKindFilter(v);
            setPage(1);
          }}
          options={BROADCAST_KIND_FILTER_OPTIONS}
        />
      </div>

      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">시간</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">종류</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">채널</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">제목</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">내용</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">상태</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((b) => (
                <tr
                  key={String(b.broadcast_id)}
                  className="transition-colors hover:bg-bg-tertiary/50"
                >
                  <td className="px-4 py-3 text-sm font-mono text-text-primary whitespace-nowrap">
                    {formatDateTime(b.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge value={b.kind} map={DISCORD_BROADCAST_KIND_MAP} />
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary">
                    {b.channel_name ?? b.channel_id ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary max-w-[220px]">
                    <span className="block truncate" title={b.title ?? undefined}>
                      {b.title ?? "-"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary max-w-[340px]">
                    <span className="block truncate" title={b.content ?? undefined}>
                      {truncate(b.content, 120)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge value={b.status} map={DISCORD_BROADCAST_STATUS_MAP} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

/* ─── 릴레이 이력 탭 ─────────────────────────────────── */

function RelaysTab() {
  const [items, setItems] = useState<DiscordBotRelay[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      const res = await apiFetch<{ items: DiscordBotRelay[]; total: number }>(
        `/discord-bot/relays?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const COLS = 4;

  return (
    <div>
      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">시간</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">이벤트 유형</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">채널</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">payload 요약</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((r) => (
                <tr
                  key={String(r.relay_id)}
                  className="transition-colors hover:bg-bg-tertiary/50"
                >
                  <td className="px-4 py-3 text-sm font-mono text-text-primary whitespace-nowrap">
                    {formatDateTime(r.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-accent">
                    {r.event_type}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary">
                    {r.channel_name ?? r.channel_id ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary max-w-[520px]">
                    <span
                      className="block truncate font-mono text-xs"
                      title={r.payload_summary ?? undefined}
                    >
                      {truncate(r.payload_summary, 160)}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

/* ─── C-가드 인증 탭 ─────────────────────────────────── */

function CGuardEventsTab() {
  const [items, setItems] = useState<DiscordBotCGuardEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      const res = await apiFetch<{ items: DiscordBotCGuardEvent[]; total: number }>(
        `/discord-bot/cguard-events?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const COLS = 5;

  return (
    <div>
      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">시간</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">사용자</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">팀</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">인증 여부</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">사유</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((c) => (
                <tr
                  key={String(c.event_id)}
                  className="transition-colors hover:bg-bg-tertiary/50"
                >
                  <td className="px-4 py-3 text-sm font-mono text-text-primary whitespace-nowrap">
                    {formatDateTime(c.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary">
                    {c.username ?? c.discord_user_id ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {c.team_name ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
                        c.verified
                          ? "text-status-ok bg-status-ok/10"
                          : "text-status-danger bg-status-danger/10",
                      )}
                    >
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          c.verified ? "bg-status-ok" : "bg-status-danger",
                        )}
                      />
                      {c.verified ? "인증 성공" : "인증 실패"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary max-w-[420px]">
                    <span className="block truncate" title={c.reason ?? undefined}>
                      {truncate(c.reason, 140)}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

/* ─── 메인 페이지 ────────────────────────────────────── */

const DEFAULT_SUMMARY: DiscordBotSummary = {
  bot_status: "unknown",
  bot_latency_ms: null,
  last_heartbeat_at: null,
  total_events: 0,
  total_broadcasts: 0,
  total_relays: 0,
  total_cguard_events: 0,
  recent_events_24h: 0,
  recent_broadcasts_24h: 0,
  recent_relays_24h: 0,
  recent_cguard_events_24h: 0,
};

export default function DiscordBotPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("events");
  const [summary, setSummary] = useState<DiscordBotSummary>(DEFAULT_SUMMARY);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const data = await apiFetch<DiscordBotSummary>("/discord-bot/summary");
      setSummary(data);
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Discord Bot 서버에 연결할 수 없습니다";
      setError(message);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    const id = setInterval(fetchSummary, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchSummary]);

  const botStatusEntry =
    DISCORD_BOT_STATUS_MAP[summary.bot_status] ?? DISCORD_BOT_STATUS_MAP.unknown;
  const botStatusColor =
    summary.bot_status === "ok"
      ? "text-status-ok"
      : summary.bot_status === "degraded"
        ? "text-status-warning"
        : summary.bot_status === "down"
          ? "text-status-danger"
          : "text-status-neutral";

  const botStatusSub =
    summary.bot_status === "ok" && summary.bot_latency_ms !== null
      ? `지연 ${summary.bot_latency_ms}ms · 최근 ${formatDateTime(summary.last_heartbeat_at)}`
      : summary.last_heartbeat_at
        ? `최근 ${formatDateTime(summary.last_heartbeat_at)}`
        : "하트비트 미수신";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Discord Bot"
        description="디스코드 봇 이벤트 · 공지 · 릴레이 · C-가드 인증 모니터링"
        actions={
          <button
            type="button"
            onClick={fetchSummary}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            새로고침
          </button>
        }
      />

      {/* 에러 표시 */}
      {error && (
        <div className="bg-status-danger/10 border border-status-danger/30 rounded-lg px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      {/* 요약 카드 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-bg-secondary border border-border rounded-xl p-5 animate-pulse"
            >
              <div className="h-3 w-20 bg-bg-tertiary rounded mb-4" />
              <div className="h-8 w-16 bg-bg-tertiary rounded" />
            </div>
          ))
        ) : (
          <>
            <SummaryCard
              label="봇 상태"
              value={botStatusEntry.label}
              sub={botStatusSub}
              icon={Activity}
              color={botStatusColor}
            />
            <SummaryCard
              label="이벤트 로그"
              value={summary.total_events}
              sub={`최근 24시간 ${summary.recent_events_24h}`}
              icon={FileText}
              color="text-status-info"
            />
            <SummaryCard
              label="공지 발송"
              value={summary.total_broadcasts}
              sub={`최근 24시간 ${summary.recent_broadcasts_24h}`}
              icon={Megaphone}
              color="text-status-warning"
            />
            <SummaryCard
              label="릴레이 이력"
              value={summary.total_relays}
              sub={`최근 24시간 ${summary.recent_relays_24h}`}
              icon={Radio}
              color="text-accent"
            />
          </>
        )}
      </div>

      {/* C-가드 연동 보조 표시 (탭 헤더 상단에 간단 카운터) */}
      {!summaryLoading && (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Shield className="w-3.5 h-3.5" />
          <span>
            C-가드 인증 이력 누적 {summary.total_cguard_events.toLocaleString()}건
            {" · "}
            최근 24시간 {summary.recent_cguard_events_24h.toLocaleString()}건
          </span>
        </div>
      )}

      {/* 탭 */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === tab.key
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      {activeTab === "events" && <EventsTab />}
      {activeTab === "broadcasts" && <BroadcastsTab />}
      {activeTab === "relays" && <RelaysTab />}
      {activeTab === "cguard" && <CGuardEventsTab />}
    </div>
  );
}
