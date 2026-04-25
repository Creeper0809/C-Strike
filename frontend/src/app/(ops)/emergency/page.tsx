"use client";

import { useCallback, useEffect, useState } from "react";
import {
  OctagonAlert,
  Pause,
  ShieldCheck,
  RefreshCw,
  AlertTriangle,
  Play,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type {
  EmergencyStatus,
  EmergencyAction,
  NetworkActionResponse,
  NetworkStatusResponse,
  NetworkTeamSummary,
} from "@/types/ops";

/* ────────────────────── Constants ────────────────────── */

const REFRESH_INTERVAL_MS = 10_000;
const PAGE_LIMIT = 20;

const ACTION_TYPE_LABELS: Record<string, string> = {
  halt_all: "전체 중단",
  halt_scoring: "채점 중단",
  halt_service: "서비스 중단",
  resume: "재개",
};

const NETWORK_TEAM_STATUS_LABELS: Record<string, string> = {
  connected: "정상",
  isolated: "격리됨",
};

/* ────────────────────── Types ────────────────────── */

interface HistoryResponse {
  items: EmergencyAction[];
  total: number;
}

type HaltAction = "halt_all" | "halt_scoring" | "resume";
type IsolationAction = "isolate" | "restore" | "isolate-all" | "restore-all";

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

/* ────────────────────── EmergencyStatusBanner ────────────────────── */

function EmergencyStatusBanner({
  status,
  onResume,
}: {
  status: EmergencyStatus;
  onResume: () => void;
}) {
  if (status.is_halted) {
    return (
      <div className="bg-status-danger/10 border border-status-danger rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <OctagonAlert className="w-6 h-6 text-status-danger shrink-0" />
            <div>
              <h2 className="text-sm font-bold text-status-danger">
                비상 상태 활성
              </h2>
              <p className="text-xs text-text-secondary mt-0.5">
                시스템이 중단 상태입니다. 대회 진행에 영향을 미치고 있습니다.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onResume}
            className="flex items-center gap-2 px-4 py-2 bg-status-ok hover:bg-status-ok/80 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
          >
            <Play className="w-4 h-4" />
            재개
          </button>
        </div>

        {/* 활성 조치 목록 */}
        {status.active_actions.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-status-danger/20">
            <h3 className="text-xs font-medium text-text-secondary">
              활성 조치
            </h3>
            {status.active_actions.map((action) => (
              <div
                key={action.id}
                className="flex items-center gap-3 text-xs bg-bg-secondary/50 rounded-lg px-3 py-2"
              >
                <span className="text-status-danger font-medium shrink-0">
                  {ACTION_TYPE_LABELS[action.action_type] ??
                    action.action_type}
                </span>
                <span className="text-text-secondary flex-1 truncate">
                  {action.reason}
                </span>
                <span className="text-text-muted font-mono shrink-0">
                  {formatDateTime(action.executed_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-status-ok/10 border border-status-ok rounded-xl p-4">
      <div className="flex items-center gap-3">
        <ShieldCheck className="w-6 h-6 text-status-ok shrink-0" />
        <div>
          <h2 className="text-sm font-bold text-status-ok">정상 운영 중</h2>
          <p className="text-xs text-text-secondary mt-0.5">
            모든 시스템이 정상 작동하고 있습니다.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── ReasonModal (이중 확인) ────────────────────── */

function ReasonModal({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  variant,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  variant: "danger" | "warning" | "ok";
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"reason" | "confirm">("reason");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      setReason("");
      setStep("reason");
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  function handleNext() {
    if (!reason.trim()) {
      setError("사유를 입력해 주세요.");
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function handleExecute() {
    setIsSubmitting(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      handleClose(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "요청 처리에 실패했습니다.";
      setError(message);
      setStep("reason");
    } finally {
      setIsSubmitting(false);
    }
  }

  const VARIANT_BUTTON: Record<string, string> = {
    danger: "bg-status-danger hover:bg-status-danger/80 text-white",
    warning: "bg-status-warning hover:bg-status-warning/80 text-white",
    ok: "bg-status-ok hover:bg-status-ok/80 text-white",
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
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
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-text-secondary leading-relaxed">
            {step === "reason" ? description : "정말 실행하시겠습니까?"}
          </Dialog.Description>

          {step === "reason" ? (
            /* 1차: 사유 입력 */
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-xs text-text-secondary mb-1 block">
                  사유 (필수)
                </span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="비상 조치 사유를 입력하세요..."
                  className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors resize-none"
                />
              </label>
              {error && (
                <p className="text-xs text-status-danger">{error}</p>
              )}
              <div className="flex items-center justify-end gap-3 pt-2">
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
                  onClick={handleNext}
                  className={cn(
                    "px-4 py-2 text-sm font-medium rounded-lg transition-colors",
                    VARIANT_BUTTON[variant]
                  )}
                >
                  다음
                </button>
              </div>
            </div>
          ) : (
            /* 2차: 최종 확인 */
            <div className="mt-4 space-y-4">
              <div className="bg-bg-secondary border border-border rounded-lg p-3">
                <p className="text-xs text-text-muted mb-1">입력된 사유:</p>
                <p className="text-sm text-text-primary">{reason}</p>
              </div>
              {error && (
                <p className="text-xs text-status-danger">{error}</p>
              )}
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setStep("reason")}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors"
                >
                  뒤로
                </button>
                <button
                  type="button"
                  onClick={handleExecute}
                  disabled={isSubmitting}
                  className={cn(
                    "px-4 py-2 text-sm font-medium rounded-lg transition-colors",
                    VARIANT_BUTTON[variant],
                    isSubmitting && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {isSubmitting ? "처리 중..." : confirmLabel}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ────────────────────── HaltControls ────────────────────── */

function HaltControls({
  isHalted,
  onAction,
}: {
  isHalted: boolean;
  onAction: (action: HaltAction, reason: string) => Promise<void>;
}) {
  const [activeModal, setActiveModal] = useState<HaltAction | null>(null);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 전체 중단 */}
        <button
          type="button"
          onClick={() => setActiveModal("halt_all")}
          disabled={isHalted}
          className={cn(
            "flex items-center gap-4 bg-status-danger text-white p-6 rounded-xl text-left transition-colors",
            isHalted
              ? "opacity-50 cursor-not-allowed"
              : "hover:bg-status-danger/80 cursor-pointer"
          )}
        >
          <OctagonAlert className="w-8 h-8 shrink-0" />
          <div>
            <p className="text-base font-bold">전체 중단</p>
            <p className="text-xs text-white/70 mt-1">
              모든 서비스와 채점을 즉시 중단합니다
            </p>
          </div>
        </button>

        {/* 채점 중단 */}
        <button
          type="button"
          onClick={() => setActiveModal("halt_scoring")}
          disabled={isHalted}
          className={cn(
            "flex items-center gap-4 bg-status-warning text-white p-4 rounded-xl text-left transition-colors",
            isHalted
              ? "opacity-50 cursor-not-allowed"
              : "hover:bg-status-warning/80 cursor-pointer"
          )}
        >
          <Pause className="w-6 h-6 shrink-0" />
          <div>
            <p className="text-base font-bold">채점 중단</p>
            <p className="text-xs text-white/70 mt-1">
              채점 시스템만 일시 중단합니다
            </p>
          </div>
        </button>
      </div>

      {/* 전체 중단 모달 */}
      <ReasonModal
        open={activeModal === "halt_all"}
        onOpenChange={(open) => !open && setActiveModal(null)}
        title="전체 중단"
        description="모든 서비스와 채점을 즉시 중단합니다. 대회 진행이 완전히 멈추게 됩니다."
        confirmLabel="전체 중단 실행"
        variant="danger"
        onConfirm={(reason) => onAction("halt_all", reason)}
      />

      {/* 채점 중단 모달 */}
      <ReasonModal
        open={activeModal === "halt_scoring"}
        onOpenChange={(open) => !open && setActiveModal(null)}
        title="채점 중단"
        description="채점 시스템만 일시 중단합니다. 서비스는 계속 운영됩니다."
        confirmLabel="채점 중단 실행"
        variant="warning"
        onConfirm={(reason) => onAction("halt_scoring", reason)}
      />
    </>
  );
}

/* ────────────────────── TeamIsolationControls ────────────────────── */

function TeamIsolationControls() {
  const [competitionId, setCompetitionId] = useState<string | null>(null);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<{
    type: IsolationAction;
    team?: NetworkTeamSummary;
  } | null>(null);

  const fetchCompetitionId = useCallback(async () => {
    const data = await apiFetch<{ items: { id: string }[] }>(
      "/v1/competitions/?page=1&size=1",
    );
    return data.items[0]?.id ?? null;
  }, []);

  const fetchNetworkStatus = useCallback(async (targetCompetitionId: string) => {
    const data = await apiFetch<NetworkStatusResponse>(
      `/v1/competitions/${targetCompetitionId}/network/status`,
    );
    setNetworkStatus(data);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const id = await fetchCompetitionId();
        if (cancelled) return;

        if (!id) {
          setCompetitionId(null);
          setNetworkStatus(null);
          setError("등록된 대회가 없어 팀 격리 제어를 사용할 수 없습니다.");
          return;
        }

        setCompetitionId(id);
        await fetchNetworkStatus(id);
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "팀 격리 상태를 불러올 수 없습니다.";
        setError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [fetchCompetitionId, fetchNetworkStatus]);

  useEffect(() => {
    if (!competitionId) return;

    const interval = setInterval(() => {
      void fetchNetworkStatus(competitionId).catch((err) => {
        const message =
          err instanceof Error ? err.message : "팀 격리 상태를 불러올 수 없습니다.";
        setError(message);
      });
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [competitionId, fetchNetworkStatus]);

  async function handleAction(action: IsolationAction, reason: string) {
    if (!competitionId) {
      throw new Error("대회 정보가 없어 요청을 처리할 수 없습니다.");
    }

    const teamId = activeModal?.team?.team_id;
    const endpoints: Record<IsolationAction, string> = {
      isolate: `/v1/competitions/${competitionId}/network/teams/${teamId}/isolate`,
      restore: `/v1/competitions/${competitionId}/network/teams/${teamId}/restore`,
      "isolate-all": `/v1/competitions/${competitionId}/network/isolate-all`,
      "restore-all": `/v1/competitions/${competitionId}/network/restore-all`,
    };

    await apiFetch<NetworkActionResponse>(endpoints[action], {
      method: "POST",
      body: JSON.stringify({ reason }),
    });

    await fetchNetworkStatus(competitionId);
    setActiveModal(null);
  }

  function openModal(type: IsolationAction, team?: NetworkTeamSummary) {
    setActiveModal({ type, team });
  }

  async function handleManualRefresh() {
    if (!competitionId) return;
    try {
      await fetchNetworkStatus(competitionId);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "팀 격리 상태를 불러올 수 없습니다.";
      setError(message);
    }
  }

  const modalConfig = activeModal
    ? {
        isolate: {
          title: `${activeModal.team?.team_name ?? "팀"} 격리`,
          description: "선택한 팀의 네트워크를 강제로 격리합니다.",
          confirmLabel: "팀 격리 실행",
          variant: "danger" as const,
        },
        restore: {
          title: `${activeModal.team?.team_name ?? "팀"} 복구`,
          description: "선택한 팀의 네트워크 격리를 해제합니다.",
          confirmLabel: "팀 복구 실행",
          variant: "ok" as const,
        },
        "isolate-all": {
          title: "전체 팀 격리",
          description: "모든 팀의 네트워크를 동시에 격리합니다.",
          confirmLabel: "전체 격리 실행",
          variant: "danger" as const,
        },
        "restore-all": {
          title: "전체 팀 복구",
          description: "모든 팀의 네트워크 격리를 해제합니다.",
          confirmLabel: "전체 복구 실행",
          variant: "ok" as const,
        },
      }[activeModal.type]
    : null;

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">
            팀 격리 제어
          </h2>
          <p className="text-xs text-text-muted mt-1">
            팀별 네트워크를 강제로 격리하거나 복구하는 운영 제어 영역입니다.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleManualRefresh()}
          disabled={!competitionId}
          className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          새로고침
        </button>
      </div>

      {loading && (
        <div className="bg-bg-secondary border border-border rounded-xl p-5">
          <div className="space-y-3 animate-pulse">
            <div className="h-4 w-32 bg-bg-tertiary rounded" />
            <div className="h-16 bg-bg-tertiary rounded" />
            <div className="h-16 bg-bg-tertiary rounded" />
          </div>
        </div>
      )}

      {!loading && !competitionId && (
        <div className="bg-bg-secondary border border-border rounded-xl p-5">
          <p className="text-sm text-text-secondary">
            {error ?? "등록된 대회가 없어 팀 격리 제어를 사용할 수 없습니다."}
          </p>
        </div>
      )}

      {networkStatus && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-bg-secondary border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">대상 팀</p>
              <p className="mt-1 text-2xl font-semibold text-text-primary">
                {networkStatus.total_teams}
              </p>
            </div>
            <div className="bg-bg-secondary border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">정상 상태</p>
              <p className="mt-1 text-2xl font-semibold text-status-ok">
                {networkStatus.teams_online}
              </p>
            </div>
            <div className="bg-bg-secondary border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">격리됨</p>
              <p className="mt-1 text-2xl font-semibold text-status-danger">
                {networkStatus.teams_isolated}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => openModal("isolate-all")}
              disabled={networkStatus.total_teams === 0 || networkStatus.is_all_isolated}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-status-danger text-white hover:bg-status-danger/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              전체 격리
            </button>
            <button
              type="button"
              onClick={() => openModal("restore-all")}
              disabled={networkStatus.teams_isolated === 0}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-status-ok text-white hover:bg-status-ok/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              전체 복구
            </button>
            {error && (
              <span className="text-xs text-status-warning">
                최신 상태 갱신 실패
              </span>
            )}
          </div>

          <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
              <div className="text-sm font-semibold text-text-primary">
                팀별 제어
              </div>
              <div className="text-xs text-text-muted">
                직접 계측이 아니라 운영 격리 상태 기준으로 표시됩니다.
              </div>
            </div>

            {networkStatus.teams.length === 0 ? (
              <div className="px-4 py-8 text-sm text-text-muted text-center">
                제어 가능한 팀이 없습니다.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {networkStatus.teams.map((team) => {
                  const isIsolated = team.status === "isolated";
                  return (
                    <div
                      key={team.team_id}
                      className="px-4 py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-text-primary">
                            {team.team_name}
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium",
                              isIsolated
                                ? "bg-status-danger/10 text-status-danger"
                                : "bg-status-ok/10 text-status-ok",
                            )}
                          >
                            {NETWORK_TEAM_STATUS_LABELS[team.status] ?? team.status}
                          </span>
                        </div>
                        <div className="text-xs text-text-secondary font-mono">
                          {team.subnet ?? "-"} / {team.gateway_ip ?? "-"}
                        </div>
                        {team.isolation_reason && (
                          <div className="text-xs text-text-muted">
                            사유: {team.isolation_reason}
                          </div>
                        )}
                        {team.isolated_at && (
                          <div className="text-xs text-text-muted">
                            격리 시각: {formatDateTime(team.isolated_at)}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {isIsolated ? (
                          <button
                            type="button"
                            onClick={() => openModal("restore", team)}
                            className="px-3 py-2 text-sm font-medium rounded-lg bg-status-ok text-white hover:bg-status-ok/80 transition-colors"
                          >
                            복구
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openModal("isolate", team)}
                            className="px-3 py-2 text-sm font-medium rounded-lg bg-status-danger text-white hover:bg-status-danger/80 transition-colors"
                          >
                            격리
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {activeModal && modalConfig && (
        <ReasonModal
          open={true}
          onOpenChange={(open) => !open && setActiveModal(null)}
          title={modalConfig.title}
          description={modalConfig.description}
          confirmLabel={modalConfig.confirmLabel}
          variant={modalConfig.variant}
          onConfirm={(reason) => handleAction(activeModal.type, reason)}
        />
      )}
    </section>
  );
}

/* ────────────────────── EmergencyHistory ────────────────────── */

function EmergencyHistory() {
  const [items, setItems] = useState<EmergencyAction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await apiFetch<HistoryResponse>(
        `/emergency/history?page=${page}&limit=${PAGE_LIMIT}`
      );
      setItems(data.items);
      setTotal(data.total);
    } catch {
      // 이력 로드 실패는 무시 (주요 기능이 아님)
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  if (loading) {
    return (
      <div className="bg-bg-secondary border border-border rounded-xl p-4 animate-pulse">
        <div className="h-4 w-32 bg-bg-tertiary rounded mb-4" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-8 bg-bg-tertiary rounded mb-2 last:mb-0"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">
          비상 조치 이력
        </h3>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
              조치 유형
            </th>
            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
              사유
            </th>
            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
              실행자
            </th>
            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
              실행 시각
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.length === 0 ? (
            <tr>
              <td
                colSpan={4}
                className="px-4 py-8 text-center text-text-muted text-sm"
              >
                비상 조치 이력이 없습니다.
              </td>
            </tr>
          ) : (
            items.map((action) => (
              <tr key={action.id} className="hover:bg-bg-tertiary/30">
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium",
                      action.action_type === "resume"
                        ? "text-status-ok bg-status-ok/10"
                        : "text-status-danger bg-status-danger/10"
                    )}
                  >
                    {ACTION_TYPE_LABELS[action.action_type] ??
                      action.action_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-text-secondary max-w-xs truncate">
                  {action.reason}
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {action.executed_by_name ?? action.executed_by}
                </td>
                <td className="px-4 py-3 text-xs text-text-muted font-mono">
                  {formatDateTime(action.executed_at)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* 페이지네이션 */}
      {total > PAGE_LIMIT && (
        <div className="flex items-center justify-center gap-2 py-3 border-t border-border">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            이전
          </button>
          <span className="text-xs text-text-muted font-mono">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            다음
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────── EmergencyPage ────────────────────── */

export default function EmergencyPage() {
  const [status, setStatus] = useState<EmergencyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resumeModalOpen, setResumeModalOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiFetch<EmergencyStatus>("/emergency/status");
      setStatus(data);
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "상태를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function handleAction(action: HaltAction, reason: string) {
    const endpoints: Record<HaltAction, string> = {
      halt_all: "/emergency/halt",
      halt_scoring: "/emergency/halt-scoring",
      resume: "/emergency/resume",
    };

    await apiFetch(endpoints[action], {
      method: "POST",
      body: JSON.stringify({ reason }),
    });

    await fetchStatus();
  }

  /* 로딩 */
  if (loading) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">비상 통제</h1>
        <div className="space-y-4">
          <div className="bg-bg-secondary border border-border rounded-xl p-6 animate-pulse">
            <div className="h-6 w-40 bg-bg-tertiary rounded" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-bg-secondary border border-border rounded-xl p-6 animate-pulse">
              <div className="h-8 w-32 bg-bg-tertiary rounded" />
            </div>
            <div className="bg-bg-secondary border border-border rounded-xl p-4 animate-pulse">
              <div className="h-6 w-28 bg-bg-tertiary rounded" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* 에러 (status 없음) */
  if (error && !status) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">비상 통제</h1>
        <div className="bg-bg-secondary border border-border rounded-xl p-8 flex flex-col items-center gap-4">
          <AlertTriangle className="w-8 h-8 text-status-warning" />
          <p className="text-status-danger text-sm">
            비상 상태를 확인할 수 없습니다
          </p>
          <p className="text-text-muted text-xs">{error}</p>
          <button
            onClick={fetchStatus}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            재시도
          </button>
        </div>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div>
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">비상 통제</h1>
        {error && (
          <span className="text-xs text-status-warning">
            최신 상태 갱신 실패
          </span>
        )}
      </div>

      <div className="space-y-6">
        {/* 1. 상태 배너 */}
        <EmergencyStatusBanner
          status={status}
          onResume={() => setResumeModalOpen(true)}
        />

        {/* 2. 킬스위치 버튼 */}
        <section>
          <h2 className="text-sm font-semibold text-text-primary mb-3">
            비상 조치
          </h2>
          <HaltControls
            isHalted={status.is_halted}
            onAction={handleAction}
          />
        </section>

        {/* 3. 팀 격리 제어 */}
        <TeamIsolationControls />

        {/* 4. 이력 테이블 */}
        <EmergencyHistory />

        {/* 5. 하단 경고 */}
        <p className="text-xs text-text-muted italic">
          이 작업은 되돌릴 수 있지만, 대회 진행에 즉각적인 영향을 미칩니다.
        </p>
      </div>

      {/* 재개 모달 */}
      <ReasonModal
        open={resumeModalOpen}
        onOpenChange={setResumeModalOpen}
        title="시스템 재개"
        description="중단된 시스템을 재개합니다. 모든 서비스가 다시 정상 운영됩니다."
        confirmLabel="재개 실행"
        variant="ok"
        onConfirm={(reason) => handleAction("resume", reason)}
      />
    </div>
  );
}
