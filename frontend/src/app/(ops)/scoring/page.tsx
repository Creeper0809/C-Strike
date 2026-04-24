"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Target,
  Pause,
  Play,
  Activity,
  Users,
  Zap,
  Hash,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/* ────────────────────── Types ────────────────────── */

interface ScoringStatus {
  is_running: boolean;
  current_round: number;
  total_rounds: number;
  last_round_at: string | null;
  success_rate: number;
  teams_checked: number;
  services_checked: number;
}

interface ScoringRound {
  round_number: number;
  started_at: string;
  completed_at: string | null;
  success_count: number;
  fail_count: number;
  error_count: number;
}

interface ScoringError {
  id: string;
  round: number;
  team_id: string;
  team_name: string;
  service_id: string;
  service_name: string;
  error_type: string;
  error_message: string;
  occurred_at: string;
}

/* ────────────────────── Constants ────────────────────── */

const REFRESH_INTERVAL_MS = 15_000;
const ROUNDS_LIMIT = 20;
const ERRORS_PAGE_LIMIT = 20;

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

/* ────────────────────── ScoringStatusOverview ────────────────────── */

function ScoringStatusOverview({ status }: { status: ScoringStatus | null }) {
  if (!status) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-bg-secondary rounded-xl p-4 animate-pulse"
          >
            <div className="h-4 w-20 bg-bg-tertiary rounded mb-3" />
            <div className="h-8 w-16 bg-bg-tertiary rounded" />
          </div>
        ))}
      </div>
    );
  }

  const stats = [
    {
      label: "현재 라운드",
      value: status.current_round,
      icon: <Hash className="w-4 h-4" />,
    },
    {
      label: "전체 라운드",
      value: status.total_rounds,
      icon: <Target className="w-4 h-4" />,
    },
    {
      label: "성공률",
      value: `${status.success_rate.toFixed(1)}%`,
      icon: <Zap className="w-4 h-4" />,
    },
    {
      label: "체크된 팀",
      value: status.teams_checked,
      icon: <Users className="w-4 h-4" />,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="bg-bg-secondary rounded-xl p-4"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary uppercase tracking-wider">
              {stat.label}
            </span>
            <span className="text-text-muted">{stat.icon}</span>
          </div>
          <p className="mt-3 text-3xl font-bold font-mono text-text-primary">
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────── ScoringControlPanel ────────────────────── */

function ScoringControlPanel({
  isRunning,
  onToggle,
}: {
  isRunning: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("사유를 입력해 주세요.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // 채점 일시 중단/재개는 비상 통제 API로 처리한다.
      // halt-scoring: emergency_actions INSERT + Redis emergency:halt publish + audit log
      // resume:       활성 action reverted_at 갱신 + Redis emergency:resume publish + audit log
      // /scoring/status 의 is_running 이 이 테이블을 조회하므로 UI 상태가 즉시 반영된다.
      const endpoint = isRunning ? "/emergency/halt-scoring" : "/emergency/resume";
      await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ reason: trimmed }),
      });
      setReason("");
      setOpen(false);
      onToggle();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "요청에 실패했습니다.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors",
          isRunning
            ? "bg-status-warning hover:bg-status-warning/80"
            : "bg-status-ok hover:bg-status-ok/80"
        )}
      >
        {isRunning ? (
          <>
            <Pause className="w-4 h-4" />
            일시 중단
          </>
        ) : (
          <>
            <Play className="w-4 h-4" />
            재개
          </>
        )}
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 bg-bg-elevated border border-border rounded-xl p-6 shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <Dialog.Close asChild>
              <button
                type="button"
                className="absolute right-4 top-4 p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                aria-label="닫기"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>

            <Dialog.Title className="text-lg font-semibold text-text-primary pr-8">
              {isRunning ? "채점 일시 중단" : "채점 재개"}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-text-secondary leading-relaxed">
              {isRunning
                ? "채점을 일시 중단합니다. 사유를 입력하세요."
                : "채점을 재개합니다. 사유를 입력하세요."}
            </Dialog.Description>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-xs text-text-secondary mb-1 block">
                  사유
                </span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="사유를 입력하세요"
                  rows={3}
                  className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors resize-none"
                />
              </label>
              {error && (
                <p className="text-xs text-status-danger">{error}</p>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors"
                >
                  취소
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isSubmitting}
                className={cn(
                  "px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors",
                  isRunning
                    ? "bg-status-warning hover:bg-status-warning/80"
                    : "bg-status-ok hover:bg-status-ok/80",
                  isSubmitting && "opacity-50 cursor-not-allowed"
                )}
              >
                {isSubmitting
                  ? "처리 중..."
                  : isRunning
                    ? "중단"
                    : "재개"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/* ────────────────────── ScoringRoundChart ────────────────────── */

function ScoringRoundChart({ rounds }: { rounds: ScoringRound[] }) {
  const chartData = [...rounds].reverse().map((r) => ({
    round: r.round_number,
    success: r.success_count,
    fail: r.fail_count,
  }));

  if (chartData.length === 0) {
    return (
      <div className="bg-bg-secondary rounded-xl p-4">
        <h3 className="text-sm font-medium text-text-secondary mb-4">
          라운드별 채점 추이
        </h3>
        <div className="flex items-center justify-center h-[300px] text-sm text-text-muted">
          라운드 데이터가 없습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-bg-secondary rounded-xl p-4">
      <h3 className="text-sm font-medium text-text-secondary mb-4">
        라운드별 채점 추이
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
          <XAxis
            dataKey="round"
            tick={{ fill: "var(--color-chart-tick)", fontSize: 12 }}
            stroke="var(--color-chart-grid)"
            label={{
              value: "라운드",
              position: "insideBottomRight",
              offset: -5,
              fill: "var(--color-chart-tick)",
              fontSize: 11,
            }}
          />
          <YAxis
            tick={{ fill: "var(--color-chart-tick)", fontSize: 12 }}
            stroke="var(--color-chart-grid)"
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-chart-tooltip-bg)",
              border: "1px solid var(--color-chart-tooltip-border)",
              borderRadius: "8px",
              color: "var(--color-chart-tooltip-text)",
              fontSize: 12,
            }}
            labelFormatter={(label) => `라운드 ${label}`}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--color-chart-tick)" }}
          />
          <Line
            type="monotone"
            dataKey="success"
            name="성공"
            stroke="var(--color-status-ok)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--color-status-ok)" }}
            activeDot={{ r: 5 }}
          />
          <Line
            type="monotone"
            dataKey="fail"
            name="실패"
            stroke="var(--color-status-danger)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--color-status-danger)" }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ────────────────────── ScoringErrorTable ────────────────────── */

function ScoringErrorTable({
  errors,
  page,
  onPageChange,
  hasMore,
  isLoading,
}: {
  errors: ScoringError[];
  page: number;
  onPageChange: (page: number) => void;
  hasMore: boolean;
  isLoading: boolean;
}) {
  return (
    <div className="bg-bg-secondary rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-status-warning" />
        <h3 className="text-sm font-medium text-text-secondary">
          채점 오류 로그
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                라운드
              </th>
              <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                팀
              </th>
              <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                서비스
              </th>
              <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                오류 유형
              </th>
              <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                메시지
              </th>
              <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                발생 시각
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
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

            {!isLoading && errors.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-sm text-text-muted"
                >
                  채점 오류가 없습니다.
                </td>
              </tr>
            )}

            {!isLoading &&
              errors.map((err) => (
                <tr key={err.id} className="hover:bg-bg-tertiary/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">
                    #{err.round}
                  </td>
                  <td className="px-4 py-3 text-text-primary">
                    {err.team_name}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {err.service_name}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium text-status-danger bg-status-danger/10">
                      {err.error_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary text-xs max-w-xs truncate">
                    {err.error_message}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted font-mono">
                    {formatDateTime(err.occurred_at)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {(page > 1 || hasMore) && (
        <div className="px-4 py-3 border-t border-border flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            이전
          </button>
          <span className="text-xs text-text-muted font-mono">
            {page} 페이지
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={!hasMore}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            다음
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────── ScoringPage ────────────────────── */

export default function ScoringPage() {
  const [status, setStatus] = useState<ScoringStatus | null>(null);
  const [rounds, setRounds] = useState<ScoringRound[]>([]);
  const [errors, setErrors] = useState<ScoringError[]>([]);
  const [errorPage, setErrorPage] = useState(1);
  const [hasMoreErrors, setHasMoreErrors] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorsLoading, setErrorsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiFetch<ScoringStatus>("/scoring/status");
      setStatus(data);
      setFetchError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "상태를 불러올 수 없습니다.";
      setFetchError(message);
    }
  }, []);

  const fetchRounds = useCallback(async () => {
    try {
      const raw = await apiFetch<ScoringRound[] | { items?: ScoringRound[] }>(
        `/scoring/rounds?limit=${ROUNDS_LIMIT}`
      );
      const list = Array.isArray(raw) ? raw : (raw.items ?? []);
      /* Mock 필드명 호환 (round→round_number 등) */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRounds(list.map((r: any) => ({
        round_number: (r.round_number ?? r.round ?? 0) as number,
        started_at: (r.started_at ?? "") as string,
        completed_at: (r.completed_at ?? r.finished_at ?? null) as string | null,
        success_count: (r.success_count ?? r.success ?? 0) as number,
        fail_count: (r.fail_count ?? r.fail ?? 0) as number,
        error_count: (r.error_count ?? r.error ?? 0) as number,
      })));
    } catch {
      setRounds([]);
    }
  }, []);

  const fetchErrors = useCallback(async () => {
    setErrorsLoading(true);
    try {
      const raw = await apiFetch<ScoringError[] | { items?: ScoringError[]; total?: number }>(
        `/scoring/errors?page=${errorPage}&limit=${ERRORS_PAGE_LIMIT}`
      );
      const errList = Array.isArray(raw) ? raw : (raw.items ?? []);
      setErrors(errList);
      setHasMoreErrors(errList.length >= ERRORS_PAGE_LIMIT);
    } catch {
      setErrors([]);
      setHasMoreErrors(false);
    } finally {
      setErrorsLoading(false);
    }
  }, [errorPage]);

  /* 초기 로드 */
  useEffect(() => {
    async function init() {
      await Promise.all([fetchStatus(), fetchRounds()]);
      setLoading(false);
    }
    init();
  }, [fetchStatus, fetchRounds]);

  /* 자동 갱신 (상태 + 라운드) */
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus();
      fetchRounds();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchRounds]);

  /* 오류 로그 페이지 변경 */
  useEffect(() => {
    fetchErrors();
  }, [fetchErrors]);

  /* 오류 로그 자동 갱신 */
  useEffect(() => {
    const interval = setInterval(fetchErrors, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchErrors]);

  function handleToggle() {
    fetchStatus();
    fetchRounds();
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">채점 모니터링</h1>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-bg-secondary border border-border rounded-xl p-4 animate-pulse"
            >
              <div className="h-4 w-48 bg-bg-tertiary rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">채점 모니터링</h1>
          {status && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                status.is_running
                  ? "bg-status-ok/10 text-status-ok"
                  : "bg-status-danger/10 text-status-danger"
              )}
            >
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  status.is_running
                    ? "bg-status-ok animate-pulse"
                    : "bg-status-danger"
                )}
              />
              {status.is_running ? "실행 중" : "중단됨"}
            </span>
          )}
          {fetchError && (
            <span className="text-xs text-status-warning">{fetchError}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              fetchStatus();
              fetchRounds();
              fetchErrors();
            }}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            aria-label="새로고침"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {status && (
            <ScoringControlPanel
              isRunning={status.is_running}
              onToggle={handleToggle}
            />
          )}
        </div>
      </div>

      {/* 상태 개요 */}
      <ScoringStatusOverview status={status} />

      {/* 서비스/마지막 라운드 정보 */}
      {status && (
        <div className="flex items-center gap-4 text-xs text-text-muted">
          <span className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            체크된 서비스: {status.services_checked}개
          </span>
          {status.last_round_at && (
            <span>
              마지막 라운드: {formatDateTime(status.last_round_at)}
            </span>
          )}
        </div>
      )}

      {/* 라운드 차트 */}
      <ScoringRoundChart rounds={rounds} />

      {/* 오류 테이블 */}
      <ScoringErrorTable
        errors={errors}
        page={errorPage}
        onPageChange={setErrorPage}
        hasMore={hasMoreErrors}
        isLoading={errorsLoading}
      />
    </div>
  );
}
