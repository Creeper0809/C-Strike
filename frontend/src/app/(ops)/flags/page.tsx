"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Flag,
  Send,
  BarChart3,
  Search,
  ChevronLeft,
  ChevronRight,
  Swords,
  ShieldCheck,
  Hash,
  Target,
  CheckCircle2,
  XCircle,
  Clock,
  Copy,
  AlertTriangle,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { FLAG_VERDICT_MAP } from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import StatusIndicator from "@/components/ui/StatusIndicator";
import StatCard from "@/components/ui/StatCard";
import type {
  FlagItem,
  FlagListResponse,
  FlagSubmissionItem,
  FlagSubmissionListResponse,
  FlagStatsResponse,
  CompetitionListResponse,
} from "@/types/ops";

/* ────────────────────── Constants ────────────────────── */

const PAGE_SIZE = 20;

type TabKey = "list" | "submissions" | "stats";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "list", label: "플래그 목록", icon: <Flag className="w-4 h-4" /> },
  { key: "submissions", label: "제출 기록", icon: <Send className="w-4 h-4" /> },
  { key: "stats", label: "통계", icon: <BarChart3 className="w-4 h-4" /> },
];

/* ────────────────────── Helpers ────────────────────── */

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return value;
  }
}

function getVerdictInfo(verdict: string) {
  return FLAG_VERDICT_MAP[verdict] ?? { label: verdict, color: "neutral" as const };
}

/* ────────────────────── FilterInput ────────────────────── */

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-text-muted mb-1 block">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
      />
    </label>
  );
}

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
        className="w-full px-3 py-1.5 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
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

/* ────────────────────── Pagination ────────────────────── */

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

  return (
    <div className="px-4 py-3 border-t border-border flex items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
        이전
      </button>
      <span className="text-xs text-text-muted font-mono">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        다음
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/* ────────────────────── SkeletonRows ────────────────────── */

function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
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

/* ────────────────────── FlagListTab ────────────────────── */

function FlagListTab({ competitionId }: { competitionId: string }) {
  const [items, setItems] = useState<FlagItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 필터 상태
  const [filterRound, setFilterRound] = useState("");
  const [filterTeam, setFilterTeam] = useState("");
  const [filterService, setFilterService] = useState("");
  const [filterActive, setFilterActive] = useState("");

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (filterRound.trim()) params.set("round_number", filterRound.trim());
      if (filterTeam.trim()) params.set("team_name", filterTeam.trim());
      if (filterService.trim()) params.set("service_name", filterService.trim());
      if (filterActive) params.set("is_active", filterActive);

      const data = await apiFetch<FlagListResponse>(`/v1/competitions/${competitionId}/flags/?${params}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      const message = err instanceof Error ? err.message : "데이터를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [competitionId, page, filterRound, filterTeam, filterService, filterActive]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function handleSearch() {
    setPage(1);
    fetchData();
  }

  return (
    <div className="space-y-4">
      {/* 필터 영역 */}
      <div className="bg-bg-secondary rounded-xl border border-border p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 items-end">
          <FilterInput
            label="라운드"
            value={filterRound}
            onChange={(v) => { setFilterRound(v); setPage(1); }}
            placeholder="라운드 번호"
            type="number"
          />
          <FilterInput
            label="팀명"
            value={filterTeam}
            onChange={(v) => { setFilterTeam(v); setPage(1); }}
            placeholder="팀명"
          />
          <FilterInput
            label="서비스명"
            value={filterService}
            onChange={(v) => { setFilterService(v); setPage(1); }}
            placeholder="서비스명"
          />
          <FilterSelect
            label="활성 상태"
            value={filterActive}
            onChange={(v) => { setFilterActive(v); setPage(1); }}
            options={[
              { value: "", label: "전체" },
              { value: "true", label: "활성" },
              { value: "false", label: "비활성" },
            ]}
          />
          <button
            type="button"
            onClick={handleSearch}
            className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-accent/20 text-accent rounded-lg text-sm font-medium hover:bg-accent/30 transition-colors self-end"
          >
            <Search className="w-3.5 h-3.5" />
            검색
          </button>
        </div>
      </div>

      {/* 에러 표시 */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-status-danger/10 border border-status-danger/20 rounded-lg text-sm text-status-danger">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* 테이블 */}
      <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">라운드</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">팀</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">서비스</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">플래그 값</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">상태</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">심은 시각</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">만료 시각</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading && <SkeletonRows cols={7} />}

              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <Flag className="w-8 h-8 text-text-muted mx-auto mb-3" />
                    <p className="text-sm text-text-muted">플래그가 없습니다.</p>
                  </td>
                </tr>
              )}

              {!loading &&
                items.map((flag) => (
                  <tr
                    key={flag.id}
                    className="hover:bg-bg-tertiary cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-text-primary">
                      #{flag.round_number}
                    </td>
                    <td className="px-4 py-3 text-text-primary text-xs">
                      {flag.team_name}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      {flag.service_name}
                    </td>
                    <td className="px-4 py-3">
                      <code className="font-mono text-xs text-accent bg-accent/10 px-1.5 py-0.5 rounded max-w-[200px] truncate inline-block">
                        {flag.flag_value}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <StatusIndicator
                        status={flag.is_active ? "ok" : "neutral"}
                        label={flag.is_active ? "활성" : "비활성"}
                        size="sm"
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted font-mono">
                      {formatDateTime(flag.planted_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted font-mono">
                      {formatDateTime(flag.expires_at)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>
    </div>
  );
}

/* ────────────────────── SubmissionsTab ────────────────────── */

function SubmissionsTab({ competitionId }: { competitionId: string }) {
  const [items, setItems] = useState<FlagSubmissionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 필터 상태
  const [filterSubmitter, setFilterSubmitter] = useState("");
  const [filterTarget, setFilterTarget] = useState("");
  const [filterVerdict, setFilterVerdict] = useState("");
  const [filterRound, setFilterRound] = useState("");

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const verdictOptions = [
    { value: "", label: "전체" },
    ...Object.entries(FLAG_VERDICT_MAP).map(([key, v]) => ({
      value: key,
      label: v.label,
    })),
  ];

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (filterSubmitter.trim()) params.set("submitter_team_name", filterSubmitter.trim());
      if (filterTarget.trim()) params.set("target_team_name", filterTarget.trim());
      if (filterVerdict) params.set("verdict", filterVerdict);
      if (filterRound.trim()) params.set("round_number", filterRound.trim());

      const data = await apiFetch<FlagSubmissionListResponse>(`/v1/competitions/${competitionId}/flags/submissions?${params}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      const message = err instanceof Error ? err.message : "데이터를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [competitionId, page, filterSubmitter, filterTarget, filterVerdict, filterRound]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function handleSearch() {
    setPage(1);
    fetchData();
  }

  return (
    <div className="space-y-4">
      {/* 필터 영역 */}
      <div className="bg-bg-secondary rounded-xl border border-border p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 items-end">
          <FilterInput
            label="제출팀"
            value={filterSubmitter}
            onChange={(v) => { setFilterSubmitter(v); setPage(1); }}
            placeholder="제출팀명"
          />
          <FilterInput
            label="피해팀"
            value={filterTarget}
            onChange={(v) => { setFilterTarget(v); setPage(1); }}
            placeholder="피해팀명"
          />
          <FilterSelect
            label="판정"
            value={filterVerdict}
            onChange={(v) => { setFilterVerdict(v); setPage(1); }}
            options={verdictOptions}
          />
          <FilterInput
            label="라운드"
            value={filterRound}
            onChange={(v) => { setFilterRound(v); setPage(1); }}
            placeholder="라운드 번호"
            type="number"
          />
          <button
            type="button"
            onClick={handleSearch}
            className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-accent/20 text-accent rounded-lg text-sm font-medium hover:bg-accent/30 transition-colors self-end"
          >
            <Search className="w-3.5 h-3.5" />
            검색
          </button>
        </div>
      </div>

      {/* 에러 표시 */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-status-danger/10 border border-status-danger/20 rounded-lg text-sm text-status-danger">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* 테이블 */}
      <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">라운드</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">제출팀</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">피해팀</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">서비스</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">제출 플래그</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">판정</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">제출 시각</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading && <SkeletonRows cols={7} />}

              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <Send className="w-8 h-8 text-text-muted mx-auto mb-3" />
                    <p className="text-sm text-text-muted">제출 기록이 없습니다.</p>
                  </td>
                </tr>
              )}

              {!loading &&
                items.map((sub) => {
                  const verdictInfo = getVerdictInfo(sub.verdict);
                  return (
                    <tr
                      key={sub.id}
                      className="hover:bg-bg-tertiary cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-text-primary">
                        {sub.round_number != null ? `#${sub.round_number}` : "-"}
                      </td>
                      <td className="px-4 py-3 text-text-primary text-xs">
                        {sub.submitter_team_name}
                      </td>
                      <td className="px-4 py-3 text-text-secondary text-xs">
                        {sub.target_team_name ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-text-secondary text-xs">
                        {sub.service_name ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        <code className="font-mono text-xs text-text-secondary bg-bg-tertiary px-1.5 py-0.5 rounded max-w-[180px] truncate inline-block">
                          {sub.submitted_flag}
                        </code>
                      </td>
                      <td className="px-4 py-3">
                        <StatusIndicator
                          status={verdictInfo.color}
                          label={verdictInfo.label}
                          size="sm"
                        />
                      </td>
                      <td className="px-4 py-3 text-xs text-text-muted font-mono">
                        {formatDateTime(sub.submitted_at)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </div>
    </div>
  );
}

/* ────────────────────── StatsTab ────────────────────── */

function StatsTab({ competitionId }: { competitionId: string }) {
  const [stats, setStats] = useState<FlagStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStats() {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<FlagStatsResponse>(
          `/v1/competitions/${competitionId}/flags/stats`
        );
        setStats(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "통계를 불러올 수 없습니다.";
        setError(message);
      } finally {
        setLoading(false);
      }
    }
    fetchStats();
  }, [competitionId]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-bg-secondary rounded-xl border border-border p-5 animate-pulse">
              <div className="h-3 w-16 bg-bg-tertiary rounded mb-3" />
              <div className="h-8 w-20 bg-bg-tertiary rounded" />
            </div>
          ))}
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-bg-secondary rounded-xl border border-border p-5 animate-pulse">
            <div className="h-4 w-32 bg-bg-tertiary rounded mb-4" />
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((__, j) => (
                <div key={j} className="h-4 w-full bg-bg-tertiary rounded" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-status-danger/10 border border-status-danger/20 rounded-lg text-sm text-status-danger">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (!stats) return null;

  // 판정별 분포 데이터 정리
  const verdictEntries = Object.entries(stats.submissions_by_verdict);
  const totalSubmissions = stats.total_submissions || 1;

  return (
    <div className="space-y-6">
      {/* 상단 요약 카드 4개 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="전체 플래그"
          value={stats.total_flags_generated.toLocaleString()}
          icon={<Flag className="w-4 h-4" />}
        />
        <StatCard
          title="전체 제출"
          value={stats.total_submissions.toLocaleString()}
          icon={<Send className="w-4 h-4" />}
        />
        <StatCard
          title="정답률"
          value={`${stats.accuracy_rate.toFixed(1)}%`}
          icon={<Target className="w-4 h-4" />}
          status={stats.accuracy_rate >= 50 ? "ok" : stats.accuracy_rate >= 20 ? "warning" : "danger"}
        />
        <div className="bg-bg-secondary rounded-xl border border-border p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary uppercase tracking-wider">판정 분포</span>
            <span className="text-text-muted"><Hash className="w-4 h-4" /></span>
          </div>
          <div className="mt-3 space-y-1.5">
            {verdictEntries.length === 0 && (
              <p className="text-xs text-text-muted">데이터 없음</p>
            )}
            {verdictEntries.map(([key, count]) => {
              const info = getVerdictInfo(key);
              const pct = ((count / totalSubmissions) * 100).toFixed(1);
              return (
                <div key={key} className="flex items-center justify-between text-xs">
                  <StatusIndicator status={info.color} label={info.label} size="sm" />
                  <span className="font-mono text-text-primary">
                    {count.toLocaleString()}{" "}
                    <span className="text-text-muted">({pct}%)</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 팀 공격 순위 테이블 */}
      <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Swords className="w-4 h-4 text-status-danger" />
          <h3 className="text-sm font-medium text-text-secondary">팀 공격 순위</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider w-12">순위</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">팀</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">전체 제출</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">정답 수</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">정확도</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">공격 팀 수</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {stats.team_attack_stats.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-text-muted">
                    공격 데이터가 없습니다.
                  </td>
                </tr>
              )}
              {stats.team_attack_stats.map((team, idx) => (
                <tr key={team.team_id} className="hover:bg-bg-tertiary transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {idx + 1}
                  </td>
                  <td className="px-4 py-3 text-text-primary text-xs font-medium">
                    {team.team_name}
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-xs font-mono text-right">
                    {team.total_submissions.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-mono text-xs text-status-ok">
                      {team.correct_submissions.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={cn(
                        "font-mono text-xs font-medium",
                        team.accuracy_rate >= 50
                          ? "text-status-ok"
                          : team.accuracy_rate >= 20
                            ? "text-status-warning"
                            : "text-status-danger"
                      )}
                    >
                      {team.accuracy_rate.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-xs font-mono text-right">
                    {team.unique_teams_attacked}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 팀 방어 순위 테이블 */}
      <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-status-ok" />
          <h3 className="text-sm font-medium text-text-secondary">팀 방어 순위</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider w-12">순위</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">팀</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">도난 플래그</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">전체 플래그</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">방어율</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {stats.team_defense_stats.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-sm text-text-muted">
                    방어 데이터가 없습니다.
                  </td>
                </tr>
              )}
              {stats.team_defense_stats.map((team, idx) => (
                <tr key={team.team_id} className="hover:bg-bg-tertiary transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {idx + 1}
                  </td>
                  <td className="px-4 py-3 text-text-primary text-xs font-medium">
                    {team.team_name}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-mono text-xs text-status-danger">
                      {team.flags_stolen.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-xs font-mono text-right">
                    {team.flags_total.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={cn(
                        "font-mono text-xs font-medium",
                        team.defense_rate >= 80
                          ? "text-status-ok"
                          : team.defense_rate >= 50
                            ? "text-status-warning"
                            : "text-status-danger"
                      )}
                    >
                      {team.defense_rate.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 서비스별 통계 테이블 */}
      {stats.service_stats.length > 0 && (
        <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Target className="w-4 h-4 text-status-info" />
            <h3 className="text-sm font-medium text-text-secondary">서비스별 통계</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">서비스</th>
                  <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">전체 탈취</th>
                  <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider text-right">라운드당 탈취율</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.service_stats.map((svc) => (
                  <tr key={svc.service_id} className="hover:bg-bg-tertiary transition-colors">
                    <td className="px-4 py-3 text-text-primary text-xs font-medium">
                      {svc.service_name}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs font-mono text-right">
                      {svc.total_captures.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs font-mono text-right">
                      {svc.capture_rate_per_round.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────── FlagsPage (메인) ────────────────────── */

export default function FlagsPage() {
  const [competitionId, setCompetitionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("list");
  const [initialLoading, setInitialLoading] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  // 첫 번째 대회 자동 조회
  useEffect(() => {
    async function fetchCompetition() {
      try {
        const data = await apiFetch<CompetitionListResponse>(
          "/v1/competitions/?page=1&size=1"
        );
        if (data.items.length > 0) {
          setCompetitionId(data.items[0].id);
        } else {
          setInitError("등록된 대회가 없습니다.");
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "대회 정보를 불러올 수 없습니다.";
        setInitError(message);
      } finally {
        setInitialLoading(false);
      }
    }
    fetchCompetition();
  }, []);

  // 로딩 화면
  if (initialLoading) {
    return (
      <div>
        <PageHeader
          title="플래그 관리"
          description="플래그 목록, 제출 기록, 통계를 조회합니다."
        />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      </div>
    );
  }

  // 초기화 에러
  if (initError || !competitionId) {
    return (
      <div>
        <PageHeader
          title="플래그 관리"
          description="플래그 목록, 제출 기록, 통계를 조회합니다."
        />
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Flag className="w-10 h-10 text-text-muted" />
          <p className="text-sm text-text-muted">
            {initError ?? "대회를 찾을 수 없습니다."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="플래그 관리"
        description="플래그 목록, 제출 기록, 통계를 조회합니다."
      />

      {/* 탭 네비게이션 */}
      <div className="border-b border-border">
        <nav className="flex gap-0 -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "flex items-center gap-2 px-5 py-3 text-sm font-medium transition-colors border-b-2",
                activeTab === tab.key
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-secondary hover:border-border"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* 탭 콘텐츠 */}
      {activeTab === "list" && <FlagListTab competitionId={competitionId} />}
      {activeTab === "submissions" && <SubmissionsTab competitionId={competitionId} />}
      {activeTab === "stats" && <StatsTab competitionId={competitionId} />}
    </div>
  );
}
