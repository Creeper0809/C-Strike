"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Box,
  RefreshCw,
  X,
  RotateCcw,
  Square,
  Cpu,
  MemoryStick,
  Clock,
  Terminal,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/* ────────────────────── Types ────────────────────── */

interface Container {
  name: string;
  status: string;
  cpu_usage: number;
  memory_usage: number;
  uptime: string;
}

interface TeamContainers {
  team_id: string;
  name: string;
  containers: Container[];
}

/* ────────────────────── Constants ────────────────────── */

const REFRESH_INTERVAL_MS = 15_000;
const LOG_LINES = 100;

const CONTAINER_STATUS_DOT: Record<string, string> = {
  running: "bg-status-ok",
  stopped: "bg-amber-500",
  error: "bg-status-danger",
};

/* ────────────────────── Helpers ────────────────────── */

function getStatusDot(status: string): string {
  return CONTAINER_STATUS_DOT[status] ?? "bg-status-neutral";
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: "실행 중",
    stopped: "중지됨",
    error: "오류",
  };
  return labels[status] ?? status;
}

/* ────────────────────── ProgressBar ────────────────────── */

function ProgressBar({
  value,
  isDanger,
  className,
}: {
  value: number;
  isDanger?: boolean;
  className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      className={cn(
        "h-1.5 rounded-full bg-bg-tertiary overflow-hidden",
        className
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all duration-300",
          isDanger ? "bg-status-danger" : "bg-accent"
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/* ────────────────────── ContainerCard ────────────────────── */

function ContainerCard({
  team,
  isSelected,
  onClick,
}: {
  team: TeamContainers;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left bg-bg-secondary border rounded-xl p-4 transition-colors hover:border-accent/50",
        isSelected ? "border-accent" : "border-border"
      )}
    >
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        {team.name}
      </h3>
      <div className="space-y-2">
        {team.containers.map((c) => (
          <div
            key={c.name}
            className="flex items-center justify-between"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  "w-2 h-2 rounded-full shrink-0",
                  getStatusDot(c.status)
                )}
              />
              <span className="text-xs text-text-primary truncate">
                {c.name}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0 ml-2">
              <span
                className={cn(
                  "text-xs font-mono",
                  c.cpu_usage > 80
                    ? "text-status-danger"
                    : "text-text-secondary"
                )}
              >
                {c.cpu_usage.toFixed(0)}%
              </span>
              <span
                className={cn(
                  "text-xs font-mono",
                  c.memory_usage > 80
                    ? "text-status-danger"
                    : "text-text-secondary"
                )}
              >
                {c.memory_usage.toFixed(0)}%
              </span>
            </div>
          </div>
        ))}
        {team.containers.length === 0 && (
          <p className="text-xs text-text-muted">컨테이너 없음</p>
        )}
      </div>
    </button>
  );
}

/* ────────────────────── ContainerDetailDrawer ────────────────────── */

function ContainerDetailDrawer({
  team,
  onClose,
  onRefresh,
}: {
  team: TeamContainers;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function fetchLogs() {
    setLogsLoading(true);
    try {
      const data = await apiFetch<{ logs: string }>(
        `/containers/${team.team_id}/logs?lines=${LOG_LINES}`
      );
      setLogs(data.logs);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "로그를 불러올 수 없습니다.";
      setLogs(`[오류] ${message}`);
    } finally {
      setLogsLoading(false);
    }
  }

  async function handleStop() {
    setStopLoading(true);
    setActionError(null);
    try {
      await apiFetch(`/containers/${team.team_id}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "운영자 수동 중단" }),
      });
      onRefresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "중단에 실패했습니다.";
      setActionError(message);
    } finally {
      setStopLoading(false);
    }
  }

  useEffect(() => {
    fetchLogs();
  }, [team.team_id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* 백드롭 */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
      />

      {/* 드로어 */}
      <div className="fixed right-0 top-0 z-50 h-full w-96 bg-bg-elevated border-l border-border overflow-y-auto">
        {/* 헤더 */}
        <div className="sticky top-0 z-10 bg-bg-elevated border-b border-border px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">
            {team.name}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* 컨테이너 상세 목록 */}
          {team.containers.map((c) => (
            <div
              key={c.name}
              className="bg-bg-secondary border border-border rounded-lg p-3 space-y-3"
            >
              {/* 이름 + 상태 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Box className="w-3.5 h-3.5 text-text-muted" />
                  <span className="text-sm font-medium text-text-primary">
                    {c.name}
                  </span>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium",
                    c.status === "running" &&
                      "text-status-ok bg-status-ok/10",
                    c.status === "stopped" &&
                      "text-amber-500 bg-amber-500/10",
                    c.status === "error" &&
                      "text-status-danger bg-status-danger/10",
                    !["running", "stopped", "error"].includes(c.status) &&
                      "text-text-muted bg-bg-tertiary"
                  )}
                >
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      getStatusDot(c.status)
                    )}
                  />
                  {getStatusLabel(c.status)}
                </span>
              </div>

              {/* CPU */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1 text-text-secondary">
                    <Cpu className="w-3 h-3" />
                    CPU
                  </span>
                  <span
                    className={cn(
                      "font-mono",
                      c.cpu_usage > 80
                        ? "text-status-danger"
                        : "text-text-primary"
                    )}
                  >
                    {c.cpu_usage.toFixed(1)}%
                  </span>
                </div>
                <ProgressBar
                  value={c.cpu_usage}
                  isDanger={c.cpu_usage > 80}
                />
              </div>

              {/* 메모리 */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1 text-text-secondary">
                    <MemoryStick className="w-3 h-3" />
                    메모리
                  </span>
                  <span
                    className={cn(
                      "font-mono",
                      c.memory_usage > 80
                        ? "text-status-danger"
                        : "text-text-primary"
                    )}
                  >
                    {c.memory_usage.toFixed(1)}%
                  </span>
                </div>
                <ProgressBar
                  value={c.memory_usage}
                  isDanger={c.memory_usage > 80}
                />
              </div>

              {/* 업타임 */}
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Clock className="w-3 h-3" />
                <span>업타임: {c.uptime}</span>
              </div>
            </div>
          ))}

          {team.containers.length === 0 && (
            <p className="text-sm text-text-muted text-center py-4">
              컨테이너가 없습니다.
            </p>
          )}

          {/* 로그 뷰어 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" />
                로그
              </h4>
              <button
                type="button"
                onClick={fetchLogs}
                disabled={logsLoading}
                className="p-1 rounded text-text-muted hover:text-text-primary transition-colors"
                aria-label="로그 새로고침"
              >
                <RefreshCw
                  className={cn(
                    "w-3.5 h-3.5",
                    logsLoading && "animate-spin"
                  )}
                />
              </button>
            </div>
            <div className="bg-bg-primary rounded-lg p-3 max-h-60 overflow-y-auto">
              {logsLoading && !logs ? (
                <p className="text-xs text-text-muted font-mono">
                  로그 로딩 중...
                </p>
              ) : logs ? (
                <pre className="font-mono text-xs text-text-secondary whitespace-pre-wrap break-all">
                  {logs}
                </pre>
              ) : (
                <p className="text-xs text-text-muted font-mono italic">
                  로그가 없습니다.
                </p>
              )}
            </div>
          </div>

          {/* 액션 버튼 */}
          {actionError && (
            <p className="text-xs text-status-danger">{actionError}</p>
          )}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setResetModal(true)}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-status-warning text-white hover:bg-status-warning/80 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              리셋
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={stopLoading}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-status-danger text-white hover:bg-status-danger/80 transition-colors",
                stopLoading && "opacity-50 cursor-not-allowed"
              )}
            >
              <Square className="w-4 h-4" />
              {stopLoading ? "처리 중..." : "중단"}
            </button>
          </div>
        </div>
      </div>

      {/* 리셋 확인 모달 */}
      <ResetConfirmModal
        open={resetModal}
        onOpenChange={setResetModal}
        teamId={team.team_id}
        teamName={team.name}
        onReset={onRefresh}
      />
    </>
  );
}

/* ────────────────────── ResetConfirmModal ────────────────────── */

function ResetConfirmModal({
  open,
  onOpenChange,
  teamId,
  teamName,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  teamName: string;
  onReset: () => void;
}) {
  const [confirmInput, setConfirmInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMatch = confirmInput === teamName;

  async function handleReset() {
    if (!isMatch) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await apiFetch(`/containers/${teamId}/reset`, {
        method: "POST",
      });
      setConfirmInput("");
      onOpenChange(false);
      onReset();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "리셋에 실패했습니다.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  /* 모달 닫힐 때 상태 초기화 */
  function handleOpenChange(value: boolean) {
    if (!value) {
      setConfirmInput("");
      setError(null);
    }
    onOpenChange(value);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-full max-w-md -translate-x-1/2 -translate-y-1/2 bg-bg-elevated border border-border rounded-xl p-6 shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
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
            컨테이너 리셋 확인
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-text-secondary leading-relaxed">
            <strong className="text-status-danger">{teamName}</strong> 팀의
            컨테이너를 리셋합니다. 이 작업은 되돌릴 수 없습니다.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                팀명을 입력하여 확인하세요
              </span>
              <input
                type="text"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={teamName}
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
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
              onClick={handleReset}
              disabled={!isMatch || isSubmitting}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-lg bg-status-danger text-white transition-colors",
                isMatch
                  ? "hover:bg-status-danger/80"
                  : "opacity-50 cursor-not-allowed",
                isSubmitting && "opacity-50 cursor-not-allowed"
              )}
            >
              {isSubmitting ? "리셋 중..." : "리셋 실행"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ────────────────────── ContainersPage ────────────────────── */

export default function ContainersPage() {
  const [teams, setTeams] = useState<TeamContainers[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContainers = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await apiFetch<any[]>("/containers/");
      // API가 flat 배열을 반환하면 팀별로 그룹핑
      if (raw.length > 0 && !("containers" in raw[0])) {
        const grouped = new Map<string, TeamContainers>();
        for (const c of raw) {
          const tid = c.team_id as string;
          if (!grouped.has(tid)) {
            grouped.set(tid, {
              team_id: tid,
              name: (c.team_code as string) ?? tid.slice(0, 8),
              containers: [],
            });
          }
          grouped.get(tid)!.containers.push({
            name: c.name ?? c.container_id?.slice(0, 12) ?? "",
            status: c.status ?? "unknown",
            cpu_usage: c.cpu_usage ?? 0,
            memory_usage: c.memory_usage ?? 0,
            uptime: c.created ?? "",
          });
        }
        setTeams(Array.from(grouped.values()));
      } else {
        setTeams(raw as TeamContainers[]);
      }
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "데이터를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  /* 초기 로드 + 자동 갱신 */
  useEffect(() => {
    fetchContainers();
    const interval = setInterval(fetchContainers, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchContainers]);

  const selectedTeam = teams.find((t) => t.team_id === selectedTeamId) ?? null;

  if (loading) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">컨테이너 관리</h1>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="bg-bg-secondary border border-border rounded-xl p-4 animate-pulse"
            >
              <div className="h-4 w-24 bg-bg-tertiary rounded mb-3" />
              <div className="space-y-2">
                <div className="h-3 w-full bg-bg-tertiary rounded" />
                <div className="h-3 w-3/4 bg-bg-tertiary rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">컨테이너 관리</h1>
          <span className="text-xs text-text-muted">
            {teams.length}개 팀
          </span>
          {error && (
            <span className="text-xs text-status-warning">{error}</span>
          )}
        </div>
        <button
          type="button"
          onClick={fetchContainers}
          className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          aria-label="새로고침"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* 그리드 */}
      {teams.length === 0 ? (
        <div className="bg-bg-secondary border border-border rounded-xl p-12 text-center">
          <Box className="w-8 h-8 text-text-muted mx-auto mb-3" />
          <p className="text-sm text-text-muted">
            등록된 팀 컨테이너가 없습니다.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {teams.map((team) => (
            <ContainerCard
              key={team.team_id}
              team={team}
              isSelected={selectedTeamId === team.team_id}
              onClick={() =>
                setSelectedTeamId(
                  selectedTeamId === team.team_id ? null : team.team_id
                )
              }
            />
          ))}
        </div>
      )}

      {/* 상세 드로어 */}
      {selectedTeam && (
        <ContainerDetailDrawer
          team={selectedTeam}
          onClose={() => setSelectedTeamId(null)}
          onRefresh={fetchContainers}
        />
      )}
    </div>
  );
}
