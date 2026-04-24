"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ChevronDown, ChevronUp, Search } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { AuditLog } from "@/types/ops";
import PageHeader from "@/components/ui/PageHeader";

/* ─── 상수 ────────────────────────────────────────────── */

const PAGE_SIZE = 30;
const DETAIL_TRUNCATE_LENGTH = 50;

const ACTION_PREFIX_TABS = [
  { value: "", label: "전체" },
  { value: "ops.", label: "운영자 활동" },
  { value: "bot.", label: "봇 활동" },
];

/* ─── 필터 상태 타입 ──────────────────────────────────── */

interface AuditFilters {
  action: string;
  actionPrefix: string;
  fromDate: string;
  toDate: string;
}

const INITIAL_FILTERS: AuditFilters = {
  action: "",
  actionPrefix: "",
  fromDate: "",
  toDate: "",
};

/* ─── 날짜/시간 포맷 ─────────────────────────────────── */

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* ─── JSON 축약 ───────────────────────────────────────── */

function truncateJson(
  details: Record<string, unknown> | null,
): string {
  if (!details) return "-";
  const str = JSON.stringify(details);
  if (str.length <= DETAIL_TRUNCATE_LENGTH) return str;
  return str.slice(0, DETAIL_TRUNCATE_LENGTH) + "...";
}

/* ─── 내보내기 형식 ───────────────────────────────────── */

type ExportFormat = "csv" | "json";

/* ─── 메인 페이지 ─────────────────────────────────────── */

export default function AuditPage() {
  /* 데이터 */
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);

  /* 필터 (입력 중) */
  const [draft, setDraft] = useState<AuditFilters>(INITIAL_FILTERS);
  /* 필터 (적용됨) */
  const [applied, setApplied] = useState<AuditFilters>(INITIAL_FILTERS);

  /* 상세 펼치기 */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /* ── 데이터 페칭 ─────────────────────────────────────── */

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (applied.action.trim()) {
        params.set("action", applied.action.trim());
      }
      if (applied.actionPrefix) {
        params.set("action_prefix", applied.actionPrefix);
      }
      if (applied.fromDate) {
        params.set("from_date", applied.fromDate);
      }
      if (applied.toDate) {
        params.set("to_date", applied.toDate);
      }

      const res = await apiFetch<{ items: AuditLog[]; total: number }>(
        `/audit/?${params.toString()}`,
      );
      setLogs(res.items);
      setTotal(res.total);
    } catch {
      setLogs([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, [page, applied]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  /* ── 필터 적용 ──────────────────────────────────────── */

  function handleApplyFilters() {
    setApplied({ ...draft });
    setPage(1);
  }

  /* ── 내보내기 ───────────────────────────────────────── */

  function handleExport(format: ExportFormat) {
    const params = new URLSearchParams({ format });
    if (applied.fromDate) params.set("from_date", applied.fromDate);
    if (applied.toDate) params.set("to_date", applied.toDate);
    window.open(`/api/audit/export?${params.toString()}`, "_blank");
  }

  /* ── 페이지네이션 ──────────────────────────────────── */

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  /* ── 상세 토글 ──────────────────────────────────────── */

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  /* ── 렌더링 ─────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <PageHeader
        title="감사 로그"
        description={`총 ${total}건`}
        actions={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleExport("csv")}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
            >
              <Download className="w-4 h-4" />
              CSV
            </button>
            <button
              type="button"
              onClick={() => handleExport("json")}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
            >
              <Download className="w-4 h-4" />
              JSON
            </button>
          </div>
        }
      />

      {/* 활동 유형 탭 */}
      <div className="flex gap-1 border-b border-border mb-4">
        {ACTION_PREFIX_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => {
              setDraft((d) => ({ ...d, actionPrefix: tab.value }));
              setApplied((a) => ({ ...a, actionPrefix: tab.value }));
              setPage(1);
            }}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              applied.actionPrefix === tab.value
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 필터 바 */}
      <div className="flex gap-3 items-end">
        <label className="block">
          <span className="text-sm text-text-secondary">액션 검색</span>
          <div className="mt-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              value={draft.action}
              onChange={(e) =>
                setDraft({ ...draft, action: e.target.value })
              }
              placeholder="ops.service.approve"
              className="w-56 pl-9 pr-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </label>

        <label className="block">
          <span className="text-sm text-text-secondary">시작일</span>
          <input
            type="date"
            value={draft.fromDate}
            onChange={(e) =>
              setDraft({ ...draft, fromDate: e.target.value })
            }
            className="mt-1 block px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>

        <label className="block">
          <span className="text-sm text-text-secondary">종료일</span>
          <input
            type="date"
            value={draft.toDate}
            onChange={(e) =>
              setDraft({ ...draft, toDate: e.target.value })
            }
            className="mt-1 block px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>

        <button
          type="button"
          onClick={handleApplyFilters}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent/80 text-white transition-colors"
        >
          적용
        </button>
      </div>

      {/* 테이블 */}
      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                시각
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                행위자
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                액션
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                대상 유형
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                IP
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                상세
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {/* 로딩 스켈레톤 */}
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skeleton-${i}`}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 w-3/4 animate-pulse rounded bg-bg-tertiary" />
                    </td>
                  ))}
                </tr>
              ))}

            {/* 빈 상태 */}
            {!isLoading && logs.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-sm text-text-muted"
                >
                  감사 로그가 없습니다
                </td>
              </tr>
            )}

            {/* 데이터 행 */}
            {!isLoading &&
              logs.map((log) => (
                <tr
                  key={log.id}
                  className="transition-colors hover:bg-bg-tertiary/50"
                >
                  <td className="px-4 py-3 text-sm text-text-primary font-mono whitespace-nowrap">
                    {formatDateTime(log.created_at)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary">
                    {log.actor_name}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-accent">
                    {log.action}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {log.target_type ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary font-mono">
                    {log.ip_address ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {log.details ? (
                      <button
                        type="button"
                        onClick={() => toggleExpand(log.id)}
                        className="inline-flex items-center gap-1 text-left hover:text-text-primary transition-colors"
                      >
                        <span className="font-mono text-xs">
                          {expandedId === log.id
                            ? JSON.stringify(log.details, null, 2)
                            : truncateJson(log.details)}
                        </span>
                        {expandedId === log.id ? (
                          <ChevronUp className="w-3 h-3 shrink-0" />
                        ) : (
                          <ChevronDown className="w-3 h-3 shrink-0" />
                        )}
                      </button>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => setPage((p) => p - 1)}
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
            onClick={() => setPage((p) => p + 1)}
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
      )}
    </div>
  );
}
