"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Rocket,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  RotateCcw,
  ChevronRight,
  Trash2,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { DEPLOY_STAGES, DEPLOY_STAGE_LABELS } from "@/lib/constants";
import type { DeployPipeline, DeployStage } from "@/types/ops";

/* ────────────────────── Types ────────────────────── */

interface PipelineListItem {
  id: string;
  service_id: string;
  triggered_by: string;
  triggered_by_name: string | null;
  service_name: string | null;
  status: string;
  current_stage: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface PipelineListResponse {
  items: PipelineListItem[];
  total: number;
}

/* ────────────────────── Constants ────────────────────── */

const REFRESH_INTERVAL_MS = 15_000;
const PAGE_LIMIT = 20;

const PIPELINE_STATUS_MAP: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  pending: {
    label: "대기",
    color: "text-status-neutral",
    bg: "bg-status-neutral/10",
  },
  running: {
    label: "실행 중",
    color: "text-status-info",
    bg: "bg-status-info/10",
  },
  success: {
    label: "성공",
    color: "text-status-ok",
    bg: "bg-status-ok/10",
  },
  failed: {
    label: "실패",
    color: "text-status-danger",
    bg: "bg-status-danger/10",
  },
  rolled_back: {
    label: "롤백됨",
    color: "text-status-warning",
    bg: "bg-status-warning/10",
  },
};

const DEFAULT_STATUS = {
  label: "알 수 없음",
  color: "text-status-neutral",
  bg: "bg-status-neutral/10",
};

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

function getStageStatus(
  stages: DeployStage[],
  stageName: string
): DeployStage | undefined {
  return stages.find((s) => s.stage_name === stageName);
}

/* ────────────────────── StatusBadge ────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const config = PIPELINE_STATUS_MAP[status] ?? DEFAULT_STATUS;
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium",
        config.color,
        config.bg
      )}
    >
      {config.label}
    </span>
  );
}

/* ────────────────────── PipelineStageView ────────────────────── */

function PipelineStageView({
  pipeline,
  onAdvance,
}: {
  pipeline: DeployPipeline;
  onAdvance?: (stageName: string) => void;
}) {
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [advancingStage, setAdvancingStage] = useState<string | null>(null);

  const stageData = selectedStage
    ? getStageStatus(pipeline.stages, selectedStage)
    : null;

  return (
    <div className="space-y-6">
      {/* 스텝퍼 */}
      <div className="flex items-center justify-between px-4">
        {DEPLOY_STAGES.map((stageName, index) => {
          const stage = getStageStatus(pipeline.stages, stageName);
          const status = stage?.status ?? "pending";
          const isLast = index === DEPLOY_STAGES.length - 1;

          return (
            <div key={stageName} className="flex items-center flex-1 last:flex-none">
              {/* 단계 노드 */}
              <button
                type="button"
                onClick={() =>
                  setSelectedStage(
                    selectedStage === stageName ? null : stageName
                  )
                }
                className={cn(
                  "flex flex-col items-center gap-2 group cursor-pointer shrink-0",
                  selectedStage === stageName && "ring-2 ring-accent/30 rounded-lg p-1 -m-1"
                )}
              >
                {/* 아이콘 */}
                {status === "success" && (
                  <CheckCircle className="w-6 h-6 text-status-ok" />
                )}
                {status === "running" && (
                  <div className="w-6 h-6 rounded-full bg-status-info status-pulse-info flex items-center justify-center">
                    <div className="w-2.5 h-2.5 rounded-full bg-white" />
                  </div>
                )}
                {status === "failed" && (
                  <XCircle className="w-6 h-6 text-status-danger" />
                )}
                {status === "pending" && (
                  <div className="w-6 h-6 rounded-full border-2 border-text-muted" />
                )}

                {/* 라벨 */}
                <span
                  className={cn(
                    "text-xs font-medium",
                    status === "success" && "text-status-ok",
                    status === "running" && "text-status-info",
                    status === "failed" && "text-status-danger",
                    status === "pending" && "text-text-muted"
                  )}
                >
                  {DEPLOY_STAGE_LABELS[stageName] ?? stageName}
                </span>

                {/* 시각 */}
                <div className="text-xs text-text-muted font-mono space-y-0.5 text-center">
                  {stage?.started_at && (
                    <div>{formatDateTime(stage.started_at)}</div>
                  )}
                  {stage?.completed_at && (
                    <div>{formatDateTime(stage.completed_at)}</div>
                  )}
                </div>
              </button>

              {/* 연결선 */}
              {!isLast && (
                <div className="flex-1 mx-2 mt-[-2rem]">
                  <div
                    className={cn(
                      "h-0.5",
                      status === "success" && "bg-status-ok",
                      status === "running" && "bg-status-info h-1",
                      status === "failed" && "bg-status-danger",
                      status === "pending" && "border-t border-dashed border-text-muted"
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 현재 진행 단계 — 자동 진행 상태 표시 */}
      {pipeline.status === "running" && pipeline.current_stage && (
        <div className="bg-status-info/10 border border-status-info/30 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <RefreshCw className="w-5 h-5 text-status-info animate-spin" />
              <div>
                <p className="text-sm font-semibold text-text-primary">
                  {DEPLOY_STAGE_LABELS[pipeline.current_stage] ?? pipeline.current_stage} 단계 진행 중...
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  각 단계가 자동으로 실행됩니다. 완료 시 다음 단계로 자동 전환됩니다.
                </p>
              </div>
            </div>
            {onAdvance && (
              <button
                type="button"
                onClick={async () => {
                  setAdvancingStage(pipeline.current_stage!);
                  try {
                    await onAdvance(pipeline.current_stage!);
                  } finally {
                    setAdvancingStage(null);
                  }
                }}
                disabled={advancingStage !== null}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors disabled:opacity-50"
              >
                {advancingStage ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <CheckCircle className="w-3 h-3" />
                )}
                수동 건너뛰기
              </button>
            )}
          </div>
        </div>
      )}

      {/* 에러 메시지 (파이프라인 수준) */}
      {pipeline.error_detail && (
        <div className="bg-status-danger/10 border border-status-danger/30 rounded-lg p-3">
          <p className="text-sm text-status-danger font-medium">
            오류: {pipeline.error_detail}
          </p>
        </div>
      )}

      {/* 로그 뷰어 (단계 클릭 시) */}
      {selectedStage && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-text-secondary">
            {DEPLOY_STAGE_LABELS[selectedStage] ?? selectedStage} 단계 로그
          </h4>
          <div className="bg-bg-primary border border-border rounded-lg p-4 max-h-64 overflow-y-auto">
            {stageData?.error_detail && (
              <p className="text-xs font-mono text-status-danger mb-2">
                [오류] {stageData.error_detail}
              </p>
            )}
            {stageData?.log_output ? (
              <pre
                className={cn(
                  "font-mono text-xs whitespace-pre-wrap break-all",
                  stageData.status === "failed"
                    ? "text-status-danger"
                    : "text-text-secondary"
                )}
              >
                {stageData.log_output}
              </pre>
            ) : (
              <p className="text-xs text-text-muted italic">로그 없음</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────── NewDeployModal ────────────────────── */

function NewDeployModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [serviceId, setServiceId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvedServices, setApprovedServices] = useState<
    { id: string; name: string; category: string }[]
  >([]);
  const [loadingServices, setLoadingServices] = useState(false);

  // 모달 열릴 때 승인된 서비스 목록 가져오기
  useEffect(() => {
    if (!open) return;
    setLoadingServices(true);
    apiFetch("/services/?status_filter=active&limit=100")
      .then((data) => {
        const items = (data as { items: { id: string; name: string; category: string }[] }).items ?? [];
        setApprovedServices(items);
      })
      .catch(() => setApprovedServices([]))
      .finally(() => setLoadingServices(false));
  }, [open]);

  async function handleCreate() {
    if (!serviceId) {
      setError("배포할 서비스를 선택해 주세요.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiFetch("/deploy/pipelines", {
        method: "POST",
        body: JSON.stringify({ service_id: serviceId }),
      });
      setServiceId("");
      onOpenChange(false);
      onCreated();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "배포 생성에 실패했습니다.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
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
            새 배포 시작
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-text-secondary leading-relaxed">
            활성 상태의 취약 서비스 중 배포할 서비스를 선택하세요.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                배포할 서비스
              </span>
              {loadingServices ? (
                <div className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-muted">
                  서비스 목록 불러오는 중...
                </div>
              ) : approvedServices.length === 0 ? (
                <div className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-muted">
                  활성 상태의 서비스가 없습니다. 먼저 취약 서비스를 등록/빌드하여 활성화하세요.
                </div>
              ) : (
                <select
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
                >
                  <option value="">서비스를 선택하세요</option>
                  {approvedServices.map((svc) => (
                    <option key={svc.id} value={svc.id}>
                      {svc.name} ({svc.category})
                    </option>
                  ))}
                </select>
              )}
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
              onClick={handleCreate}
              disabled={isSubmitting}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent-hover text-white transition-colors",
                isSubmitting && "opacity-50 cursor-not-allowed"
              )}
            >
              {isSubmitting ? "생성 중..." : "배포 시작"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ────────────────────── RollbackConfirmModal ────────────────────── */

function RollbackConfirmModal({
  open,
  onOpenChange,
  pipeline,
  onConfirm,
  isLoading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipeline: DeployPipeline;
  onConfirm: () => void;
  isLoading: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
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

          <Dialog.Title className="text-lg font-semibold text-text-primary pr-8 flex items-center gap-2">
            <RotateCcw className="w-5 h-5 text-status-warning" />
            롤백 확인
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-text-secondary leading-relaxed">
            정말 이 파이프라인을 롤백하시겠습니까? 이 작업은 되돌릴 수 없습니다.
          </Dialog.Description>

          {/* 파이프라인 정보 */}
          <div className="mt-4 bg-bg-secondary border border-border rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted">파이프라인 ID</span>
              <span className="text-text-primary font-mono">
                {pipeline.id.slice(0, 12)}...
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted">현재 상태</span>
              <StatusBadge status={pipeline.status} />
            </div>
            {pipeline.current_stage && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-muted">현재 단계</span>
                <span className="text-text-primary">
                  {DEPLOY_STAGE_LABELS[pipeline.current_stage] ??
                    pipeline.current_stage}
                </span>
              </div>
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
              onClick={onConfirm}
              disabled={isLoading}
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-status-warning/10 text-status-warning border border-status-warning/30 hover:bg-status-warning/20 transition-colors",
                isLoading && "opacity-50 cursor-not-allowed"
              )}
            >
              <RotateCcw className="w-4 h-4" />
              {isLoading ? "처리 중..." : "롤백 실행"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ────────────────────── DeployPage ────────────────────── */

export default function DeployPage() {
  const [pipelines, setPipelines] = useState<PipelineListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedPipeline, setSelectedPipeline] =
    useState<DeployPipeline | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [rollbackModalOpen, setRollbackModalOpen] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  /* 목록 조회 */
  const fetchPipelines = useCallback(async () => {
    try {
      const data = await apiFetch<PipelineListResponse>(
        `/deploy/pipelines?page=${page}&limit=${PAGE_LIMIT}`
      );
      setPipelines(data.items);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "데이터를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [page]);

  /* 상세 조회 */
  async function fetchDetail(id: string) {
    setDetailLoading(true);
    try {
      const data = await apiFetch<DeployPipeline>(
        `/deploy/pipelines/${id}`
      );
      setSelectedPipeline(data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "상세 정보를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setDetailLoading(false);
    }
  }

  /* 롤백 */
  async function handleAdvanceStage(stageName: string) {
    if (!selectedPipeline) return;
    await apiFetch(
      `/deploy/pipelines/${selectedPipeline.id}/stages/${stageName}/advance`,
      { method: "POST" },
    );
    await fetchDetail(selectedPipeline.id);
    await fetchPipelines();
  }

  async function handleRollback() {
    if (!selectedPipeline) return;
    setRollbackLoading(true);
    try {
      await apiFetch(`/deploy/pipelines/${selectedPipeline.id}/rollback`, {
        method: "POST",
      });
      setRollbackModalOpen(false);
      await fetchDetail(selectedPipeline.id);
      await fetchPipelines();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "롤백에 실패했습니다.";
      setError(message);
    } finally {
      setRollbackLoading(false);
    }
  }

  /* 삭제 — running은 거부, success/failed/rolled_back 등은 레코드만 제거 */
  async function handleDelete() {
    if (!selectedPipeline) return;
    if (selectedPipeline.status === "running") {
      alert("실행 중인 파이프라인은 삭제할 수 없습니다.");
      return;
    }
    const ok = window.confirm(
      "이 배포 파이프라인 레코드를 삭제하시겠습니까?\n실제 배포된 컨테이너는 유지되며, 파이프라인 이력만 제거됩니다.",
    );
    if (!ok) return;
    setDeleteLoading(true);
    try {
      await apiFetch(`/deploy/pipelines/${selectedPipeline.id}`, {
        method: "DELETE",
      });
      setSelectedPipeline(null);
      await fetchPipelines();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "파이프라인 삭제에 실패했습니다.";
      setError(message);
      alert(message);
    } finally {
      setDeleteLoading(false);
    }
  }

  /* 자동 갱신 */
  useEffect(() => {
    fetchPipelines();
    const interval = setInterval(fetchPipelines, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchPipelines]);

  /* 선택된 파이프라인 자동 갱신 (running일 때 3초, 그 외 15초) */
  useEffect(() => {
    if (!selectedPipeline) return;
    const ms = selectedPipeline.status === "running" ? 3_000 : REFRESH_INTERVAL_MS;
    const interval = setInterval(
      () => fetchDetail(selectedPipeline.id),
      ms,
    );
    return () => clearInterval(interval);
  }, [selectedPipeline?.id, selectedPipeline?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
  const canRollback =
    selectedPipeline?.status === "success" ||
    selectedPipeline?.status === "failed";
  const canDelete =
    selectedPipeline !== null && selectedPipeline.status !== "running";

  /* 로딩 */
  if (loading) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">배포 관리</h1>
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
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
    <div>
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">배포 관리</h1>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-status-warning">{error}</span>
          )}
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Rocket className="w-4 h-4" />
            새 배포
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {/* 파이프라인 목록 테이블 */}
        <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                  서비스 ID
                </th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                  상태
                </th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                  현재 단계
                </th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                  시작 시각
                </th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">
                  완료 시각
                </th>
                <th className="px-4 py-3 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pipelines.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-text-muted text-sm"
                  >
                    등록된 배포 파이프라인이 없습니다.
                  </td>
                </tr>
              ) : (
                pipelines.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => fetchDetail(p.id)}
                    className={cn(
                      "cursor-pointer hover:bg-bg-tertiary/50 transition-colors",
                      selectedPipeline?.id === p.id && "bg-bg-tertiary/50"
                    )}
                  >
                    <td className="px-4 py-3 text-xs text-text-primary">
                      {p.service_name ?? `${p.service_id.slice(0, 8)}...`}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {p.current_stage
                        ? (DEPLOY_STAGE_LABELS[p.current_stage] ??
                            p.current_stage)
                        : "-"}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted font-mono">
                      {formatDateTime(p.started_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted font-mono">
                      {formatDateTime(p.completed_at)}
                    </td>
                    <td className="px-4 py-3">
                      <ChevronRight className="w-4 h-4 text-text-muted" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 페이지네이션 */}
        {total > PAGE_LIMIT && (
          <div className="flex items-center justify-center gap-2">
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

        {/* 상세 패널 */}
        {detailLoading && (
          <div className="bg-bg-secondary border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 text-text-muted text-sm">
              <RefreshCw className="w-4 h-4 animate-spin" />
              상세 정보 로드 중...
            </div>
          </div>
        )}

        {selectedPipeline && !detailLoading && (
          <div className="bg-bg-secondary border border-border rounded-xl p-6 space-y-6">
            {/* 상세 헤더 */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-text-primary">
                    파이프라인 상세
                  </h3>
                  <StatusBadge status={selectedPipeline.status} />
                </div>
                <p className="text-xs text-text-muted font-mono">
                  ID: {selectedPipeline.id}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {canRollback && (
                  <button
                    type="button"
                    onClick={() => setRollbackModalOpen(true)}
                    disabled={rollbackLoading}
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-status-warning/10 text-status-warning border border-status-warning/30 hover:bg-status-warning/20 transition-colors",
                      rollbackLoading && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <RotateCcw className="w-4 h-4" />
                    {rollbackLoading ? "처리 중..." : "롤백"}
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleteLoading}
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-status-danger/10 text-status-danger border border-status-danger/30 hover:bg-status-danger/20 transition-colors",
                      deleteLoading && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <Trash2 className="w-4 h-4" />
                    {deleteLoading ? "삭제 중..." : "삭제"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedPipeline(null)}
                  className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                  aria-label="닫기"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* 스텝퍼 + 로그 */}
            <PipelineStageView pipeline={selectedPipeline} onAdvance={handleAdvanceStage} />
          </div>
        )}
      </div>

      {/* 새 배포 모달 */}
      <NewDeployModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onCreated={fetchPipelines}
      />

      {/* 롤백 확인 모달 */}
      {selectedPipeline && (
        <RollbackConfirmModal
          open={rollbackModalOpen}
          onOpenChange={setRollbackModalOpen}
          pipeline={selectedPipeline}
          onConfirm={handleRollback}
          isLoading={rollbackLoading}
        />
      )}
    </div>
  );
}
