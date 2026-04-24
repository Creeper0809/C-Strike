"use client";

import { useCallback, useEffect, useState } from "react";
import { Shield, ShieldAlert, Activity, Ban, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  CGUARD_SESSION_STATUS_MAP,
  CGUARD_SEVERITY_MAP,
  CGUARD_BAN_STATUS_MAP,
  STATUS_COLORS,
} from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import type {
  CGuardSummary,
  CGuardSession,
  CGuardEvent,
  CGuardBan,
  CGuardAuditLog,
} from "@/types/ops";

/* ─── 상수 ────────────────────────────────────────────── */

const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 30_000;

type TabKey = "sessions" | "events" | "bans" | "audit";

const TABS: { key: TabKey; label: string }[] = [
  { key: "sessions", label: "세션" },
  { key: "events", label: "이벤트" },
  { key: "bans", label: "차단" },
  { key: "audit", label: "감사로그" },
];

const SESSION_FILTER_OPTIONS = [
  { value: "", label: "전체" },
  { value: "ACTIVE", label: "활성" },
  { value: "RESTRICTED", label: "제한" },
  { value: "BLOCKED", label: "차단" },
  { value: "OFFLINE", label: "오프라인" },
];

const SEVERITY_FILTER_OPTIONS = [
  { value: "", label: "전체" },
  { value: "low", label: "낮음" },
  { value: "medium", label: "보통" },
  { value: "high", label: "높음" },
  { value: "critical", label: "긴급" },
];

const BAN_FILTER_OPTIONS = [
  { value: "", label: "전체" },
  { value: "ACTIVE", label: "활성" },
  { value: "EXPIRED", label: "만료" },
  { value: "REVOKED", label: "해제" },
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

function StatusBadge({
  value,
  map,
}: {
  value: string;
  map: Record<string, { label: string; color: keyof typeof STATUS_COLORS }>;
}) {
  const entry = map[value];
  if (!entry) {
    return <span className="text-xs text-text-muted">{value}</span>;
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
  value: number;
  icon: React.ElementType;
  color: string;
}

function SummaryCard({ label, value, icon: Icon, color }: SummaryCardProps) {
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

/* ─── 세션 탭 ────────────────────────────────────────── */

function SessionsTab() {
  const [items, setItems] = useState<CGuardSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (statusFilter) params.set("status", statusFilter);
      const res = await apiFetch<{ items: CGuardSession[]; total: number }>(
        `/cguard/sessions?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const COLS = 7;

  return (
    <div>
      <div className="flex gap-3 items-end mb-4">
        <FilterSelect
          label="상태"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={SESSION_FILTER_OPTIONS}
        />
      </div>

      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">사용자명</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">팀</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">상태</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">판정상태</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">위험점수</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">최근 IP</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">마지막 하트비트</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((s) => (
                <tr key={s.session_id} className="transition-colors hover:bg-bg-tertiary/50">
                  <td className="px-4 py-3 text-sm text-text-primary">{s.username ?? s.user_id}</td>
                  <td className="px-4 py-3 text-sm text-text-secondary">{s.team_name ?? "-"}</td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge value={s.status} map={CGUARD_SESSION_STATUS_MAP} />
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary font-mono">{s.decision_status ?? "-"}</td>
                  <td className="px-4 py-3 text-sm font-mono text-text-primary">
                    {s.risk_score !== null ? s.risk_score : "-"}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary">{s.last_ip ?? "-"}</td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary whitespace-nowrap">
                    {formatDateTime(s.last_heartbeat_at)}
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

/* ─── 이벤트 탭 ──────────────────────────────────────── */

function EventsTab() {
  const [items, setItems] = useState<CGuardEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [severityFilter, setSeverityFilter] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (severityFilter) params.set("severity", severityFilter);
      const res = await apiFetch<{ items: CGuardEvent[]; total: number }>(
        `/cguard/events?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, severityFilter]);

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
      <div className="flex gap-3 items-end mb-4">
        <FilterSelect
          label="심각도"
          value={severityFilter}
          onChange={(v) => {
            setSeverityFilter(v);
            setPage(1);
          }}
          options={SEVERITY_FILTER_OPTIONS}
        />
      </div>

      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">시간</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">이벤트 유형</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">심각도</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">사용자</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">클라이언트 버전</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((e) => (
                <tr key={e.event_id} className="transition-colors hover:bg-bg-tertiary/50">
                  <td className="px-4 py-3 text-sm font-mono text-text-primary whitespace-nowrap">
                    {formatDateTime(e.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-accent">{e.event_type}</td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge value={e.severity} map={CGUARD_SEVERITY_MAP} />
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary">{e.username ?? "-"}</td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary">{e.client_version}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

/* ─── 차단 탭 ────────────────────────────────────────── */

function BansTab() {
  const [items, setItems] = useState<CGuardBan[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (statusFilter) params.set("status", statusFilter);
      const res = await apiFetch<{ items: CGuardBan[]; total: number }>(
        `/cguard/bans?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const id = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const COLS = 7;

  return (
    <div>
      <div className="flex gap-3 items-end mb-4">
        <FilterSelect
          label="상태"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={BAN_FILTER_OPTIONS}
        />
      </div>

      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">대상</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">범위</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">사유</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">생성자</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">일시</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">만료일</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">상태</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((b) => (
                <tr key={b.ban_id} className="transition-colors hover:bg-bg-tertiary/50">
                  <td className="px-4 py-3 text-sm font-mono text-text-primary">{b.target_id}</td>
                  <td className="px-4 py-3 text-sm text-text-secondary">{b.scope}</td>
                  <td className="px-4 py-3 text-sm text-text-secondary max-w-[200px] truncate">
                    {b.reason ?? b.reason_code ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary">{b.created_by}</td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary whitespace-nowrap">
                    {formatDateTime(b.created_at)}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary whitespace-nowrap">
                    {formatDateTime(b.expires_at)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge value={b.status} map={CGUARD_BAN_STATUS_MAP} />
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

/* ─── 감사로그 탭 ────────────────────────────────────── */

function AuditTab() {
  const [items, setItems] = useState<CGuardAuditLog[]>([]);
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
      const res = await apiFetch<{ items: CGuardAuditLog[]; total: number }>(
        `/cguard/audit-logs?${params.toString()}`,
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
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">행위자</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">액션</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">대상 유형</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">대상 ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableSkeleton cols={COLS} />}
            {!loading && items.length === 0 && <EmptyRow cols={COLS} />}
            {!loading &&
              items.map((a) => (
                <tr key={a.audit_id} className="transition-colors hover:bg-bg-tertiary/50">
                  <td className="px-4 py-3 text-sm font-mono text-text-primary whitespace-nowrap">
                    {formatDateTime(a.at)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary">{a.actor}</td>
                  <td className="px-4 py-3 text-sm font-mono text-accent">{a.action}</td>
                  <td className="px-4 py-3 text-sm text-text-secondary">{a.object_type ?? "-"}</td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary">{a.object_id ?? "-"}</td>
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

const DEFAULT_SUMMARY: CGuardSummary = {
  total_sessions: 0,
  active_sessions: 0,
  blocked_sessions: 0,
  restricted_sessions: 0,
  c_guard_ok_count: 0,
  total_events: 0,
  active_bans: 0,
};

export default function CGuardPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("sessions");
  const [summary, setSummary] = useState<CGuardSummary>(DEFAULT_SUMMARY);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const data = await apiFetch<CGuardSummary>("/cguard/summary");
      setSummary(data);
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "C-Guard 서버에 연결할 수 없습니다";
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="C-Guard"
        description="클라이언트 무결성 모니터링"
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
              label="활성 세션"
              value={summary.active_sessions}
              icon={Shield}
              color="text-status-ok"
            />
            <SummaryCard
              label="차단 세션"
              value={summary.blocked_sessions}
              icon={ShieldAlert}
              color="text-status-danger"
            />
            <SummaryCard
              label="보안 이벤트"
              value={summary.total_events}
              icon={Activity}
              color="text-status-warning"
            />
            <SummaryCard
              label="활성 차단"
              value={summary.active_bans}
              icon={Ban}
              color="text-status-danger"
            />
          </>
        )}
      </div>

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
      {activeTab === "sessions" && <SessionsTab />}
      {activeTab === "events" && <EventsTab />}
      {activeTab === "bans" && <BansTab />}
      {activeTab === "audit" && <AuditTab />}
    </div>
  );
}
