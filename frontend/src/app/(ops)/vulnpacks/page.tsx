"use client";

import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Package,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { VulnpackSchedule } from "@/types/ops";
import PageHeader from "@/components/ui/PageHeader";

/* ─── 상수 ────────────────────────────────────────────── */

const PACK_STATUS_MAP: Record<
  string,
  { label: string; color: string; border: string; icon: "check" | "clock" | "x" }
> = {
  released: {
    label: "공개됨",
    color: "text-status-ok",
    border: "border-status-ok/40",
    icon: "check",
  },
  scheduled: {
    label: "예정됨",
    color: "text-text-secondary",
    border: "border-border",
    icon: "clock",
  },
  cancelled: {
    label: "취소됨",
    color: "text-text-muted",
    border: "border-border/50",
    icon: "x",
  },
};

const STATUS_ICON_MAP = {
  check: CheckCircle2,
  clock: Clock,
  x: XCircle,
} as const;

/* ─── 시간 포맷 ───────────────────────────────────────── */

function formatMinutesToLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ─── 팩 카드 컴포넌트 ────────────────────────────────── */

interface VulnPackCardProps {
  pack: VulnpackSchedule;
  onRelease: (id: string) => void;
  onDelete: (id: string) => void;
  isReleasing: boolean;
  isDeleting: boolean;
}

function VulnPackCard({ pack, onRelease, onDelete, isReleasing, isDeleting }: VulnPackCardProps) {
  const statusInfo = PACK_STATUS_MAP[pack.status] ?? PACK_STATUS_MAP.scheduled;
  const StatusIcon = STATUS_ICON_MAP[statusInfo.icon];
  const isCancelled = pack.status === "cancelled";
  const isReleased = pack.status === "released";
  const isScheduled = pack.status === "scheduled";

  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleReleaseClick() {
    if (releaseConfirmOpen) {
      onRelease(pack.id);
      setReleaseConfirmOpen(false);
    } else {
      setReleaseConfirmOpen(true);
      setDeleteConfirmOpen(false);
    }
  }

  function handleDeleteClick() {
    if (deleteConfirmOpen) {
      onDelete(pack.id);
      setDeleteConfirmOpen(false);
    } else {
      setDeleteConfirmOpen(true);
      setReleaseConfirmOpen(false);
    }
  }

  return (
    <div
      className={cn(
        "bg-bg-secondary border rounded-xl p-4 w-52 shrink-0 transition-colors",
        statusInfo.border,
        isCancelled && "opacity-60",
      )}
    >
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Package
            className={cn("w-4 h-4", statusInfo.color)}
          />
          <span
            className={cn(
              "text-sm font-semibold text-text-primary",
              isCancelled && "line-through",
            )}
          >
            팩 {pack.pack_number}
          </span>
        </div>
        <StatusIcon className={cn("w-4 h-4", statusInfo.color)} />
      </div>

      {/* 라벨 */}
      {pack.label && (
        <p
          className={cn(
            "text-xs text-text-secondary mb-2 truncate",
            isCancelled && "line-through",
          )}
          title={pack.label}
        >
          {pack.label}
        </p>
      )}

      {/* 상태 뱃지 */}
      <span
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
          statusInfo.color,
          isReleased && "bg-status-ok/15",
          isScheduled && "bg-bg-tertiary",
          isCancelled && "bg-bg-tertiary/50",
        )}
      >
        {statusInfo.label}
      </span>

      {/* 서비스 수 */}
      <div className="mt-3 text-xs text-text-muted">
        <span>포함 서비스: </span>
        <span className="text-text-secondary font-medium">
          {pack.service_ids.length}개
        </span>
      </div>

      {/* 서비스 ID 목록 (축약) */}
      {pack.service_ids.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {pack.service_ids.slice(0, 3).map((sid) => (
            <div
              key={sid}
              className="text-xs text-text-secondary truncate"
              title={sid}
            >
              {pack.service_names?.[sid] ?? `${sid.slice(0, 8)}...`}
            </div>
          ))}
          {pack.service_ids.length > 3 && (
            <div className="text-xs text-text-muted">
              외 {pack.service_ids.length - 3}개
            </div>
          )}
        </div>
      )}

      {/* 공개일시 (released) */}
      {isReleased && pack.actual_release_at && (
        <div className="mt-3 pt-2 border-t border-border/50 text-xs text-status-ok">
          {formatDateTime(pack.actual_release_at)} 공개
        </div>
      )}

      {/* 수동 공개 버튼 (scheduled) */}
      {isScheduled && (
        <div className="mt-3 pt-2 border-t border-border/50">
          {releaseConfirmOpen ? (
            <div className="space-y-1.5">
              <p className="text-xs text-status-warning">
                정말 공개하시겠습니까?
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={handleReleaseClick}
                  disabled={isReleasing}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-accent hover:bg-accent/80 text-white transition-colors disabled:opacity-50"
                >
                  {isReleasing ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Play className="w-3 h-3" />
                  )}
                  확인
                </button>
                <button
                  type="button"
                  onClick={() => setReleaseConfirmOpen(false)}
                  className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
                >
                  취소
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleReleaseClick}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors"
            >
              <Play className="w-3 h-3" />
              수동 공개
            </button>
          )}
        </div>
      )}

      {/* 삭제 버튼 — 모든 상태(scheduled/released/cancelled)에서 허용 */}
      <div
        className={cn(
          "mt-1.5",
          !isScheduled && "pt-2 border-t border-border/50",
        )}
      >
        {deleteConfirmOpen ? (
          <div className="space-y-1.5">
            <p className="text-xs text-status-danger">
              {isReleased
                ? "공개된 팩 기록을 삭제합니다. 이미 배포된 컨테이너는 유지됩니다."
                : "정말 삭제하시겠습니까?"}
            </p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={handleDeleteClick}
                disabled={isDeleting}
                className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-status-danger/15 text-status-danger border border-status-danger/30 hover:bg-status-danger/25 transition-colors disabled:opacity-50"
              >
                {isDeleting ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Trash2 className="w-3 h-3" />
                )}
                삭제 확정
              </button>
              <button
                type="button"
                onClick={() => setDeleteConfirmOpen(false)}
                className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleDeleteClick}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-status-danger/70 hover:text-status-danger hover:bg-status-danger/10 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            삭제
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── 타임라인 연결선 컴포넌트 ────────────────────────── */

function TimelineConnector() {
  return (
    <div className="flex items-center shrink-0">
      <div className="w-8 border-t-2 border-dashed border-border" />
    </div>
  );
}

/* ─── 타임라인 시간 마커 ──────────────────────────────── */

function TimeMarker({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center shrink-0 w-52">
      <div className="w-2 h-2 rounded-full bg-text-muted mb-1" />
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  );
}

/* ─── 메인 페이지 ─────────────────────────────────────── */

export default function VulnpacksPage() {
  const [packs, setPacks] = useState<VulnpackSchedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /* ── 팩 추가 모달 ───────────────────────────────────── */

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    pack_number: 1,
    label: "",
    service_ids: [] as string[],
    scheduled_offset_minutes: 0,
  });
  const [approvedServices, setApprovedServices] = useState<
    { id: string; name: string; category: string }[]
  >([]);
  const [isCreating, setIsCreating] = useState(false);

  /* ── 데이터 페칭 ─────────────────────────────────────── */

  const fetchPacks = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiFetch<VulnpackSchedule[]>("/vulnpacks/");
      setPacks(data);
    } catch {
      setPacks([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPacks();
  }, [fetchPacks]);

  /* ── 수동 공개 ───────────────────────────────────────── */

  async function handleRelease(id: string) {
    setReleasingId(id);
    try {
      await apiFetch(`/vulnpacks/${id}/release`, { method: "POST" });
      await fetchPacks();
    } finally {
      setReleasingId(null);
    }
  }

  /* ── 서비스 목록 fetch (모달 열릴 때) ────────────────── */

  useEffect(() => {
    if (!createOpen) return;
    apiFetch("/services/?status_filter=active&limit=100")
      .then((data) => {
        const items = (data as { items: { id: string; name: string; category: string }[] }).items ?? [];
        setApprovedServices(items);
      })
      .catch(() => setApprovedServices([]));
  }, [createOpen]);

  /* ── 팩 추가 ─────────────────────────────────────────── */

  async function handleCreate() {
    if (!createForm.label.trim() || createForm.service_ids.length === 0) return;
    setIsCreating(true);
    try {
      await apiFetch("/vulnpacks/", {
        method: "POST",
        body: JSON.stringify(createForm),
      });
      setCreateOpen(false);
      setCreateForm({
        pack_number: packs.length + 2,
        label: "",
        service_ids: [],
        scheduled_offset_minutes: 0,
      });
      await fetchPacks();
    } finally {
      setIsCreating(false);
    }
  }

  /* ── 팩 삭제 ─────────────────────────────────────────── */

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await apiFetch(`/vulnpacks/${id}`, { method: "DELETE" });
      await fetchPacks();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "취약점팩 삭제에 실패했습니다.";
      alert(message);
    } finally {
      setDeletingId(null);
    }
  }

  /* ── 팩 정렬 (offset 기준) ──────────────────────────── */

  const sortedPacks = [...packs].sort(
    (a, b) => a.scheduled_offset_minutes - b.scheduled_offset_minutes,
  );

  /* ── 통계 ────────────────────────────────────────────── */

  const releasedCount = packs.filter((p) => p.status === "released").length;
  const scheduledCount = packs.filter((p) => p.status === "scheduled").length;
  const totalCount = packs.length;

  /* ── 렌더링 ──────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-start justify-between">
        <PageHeader
          title="취약점팩 일정 관리"
          description={`총 ${totalCount}개 팩 | 공개 ${releasedCount}개 | 예정 ${scheduledCount}개`}
        />
        <button
          type="button"
          onClick={() => {
            setCreateForm(f => ({ ...f, pack_number: packs.length + 1 }));
            setCreateOpen(true);
          }}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent/80 text-white transition-colors"
        >
          <Plus className="w-4 h-4" />
          팩 추가
        </button>
      </div>

      {/* 로딩 */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
          <span className="ml-2 text-sm text-text-muted">
            팩 정보를 불러오는 중...
          </span>
        </div>
      )}

      {/* 빈 상태 */}
      {!isLoading && packs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <Package className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">등록된 취약점팩이 없습니다</p>
        </div>
      )}

      {/* 타임라인 */}
      {!isLoading && sortedPacks.length > 0 && (
        <div className="space-y-4">
          {/* 카드 타임라인 */}
          <div className="bg-bg-secondary border border-border rounded-xl p-6 overflow-x-auto">
            <div className="flex items-start min-w-max">
              {sortedPacks.map((pack, idx) => (
                <div key={pack.id} className="flex items-start">
                  <VulnPackCard
                    pack={pack}
                    onRelease={handleRelease}
                    onDelete={handleDelete}
                    isReleasing={releasingId === pack.id}
                    isDeleting={deletingId === pack.id}
                  />
                  {idx < sortedPacks.length - 1 && <TimelineConnector />}
                </div>
              ))}
            </div>

            {/* 시간 축 */}
            <div className="flex items-center mt-4 pt-4 border-t border-border/50 min-w-max">
              {sortedPacks.map((pack, idx) => (
                <div key={pack.id} className="flex items-center">
                  <TimeMarker
                    label={formatMinutesToLabel(pack.scheduled_offset_minutes)}
                  />
                  {idx < sortedPacks.length - 1 && (
                    <div className="w-8 shrink-0" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 상세 목록 (보조) */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedPacks.map((pack) => {
              const statusInfo =
                PACK_STATUS_MAP[pack.status] ?? PACK_STATUS_MAP.scheduled;
              const StatusIcon = STATUS_ICON_MAP[statusInfo.icon];

              return (
                <div
                  key={pack.id}
                  className={cn(
                    "bg-bg-secondary border rounded-xl p-4",
                    statusInfo.border,
                    pack.status === "cancelled" && "opacity-60",
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-text-primary">
                      팩 {pack.pack_number}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-xs font-medium",
                        statusInfo.color,
                      )}
                    >
                      <StatusIcon className="w-3.5 h-3.5" />
                      {statusInfo.label}
                    </span>
                  </div>

                  {pack.label && (
                    <p className="text-xs text-text-secondary mb-2">
                      {pack.label}
                    </p>
                  )}

                  <div className="space-y-1 text-xs text-text-muted">
                    <div className="flex justify-between">
                      <span>오프셋</span>
                      <span className="text-text-secondary">
                        {formatMinutesToLabel(pack.scheduled_offset_minutes)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>서비스 수</span>
                      <span className="text-text-secondary">
                        {pack.service_ids.length}개
                      </span>
                    </div>
                    {pack.actual_release_at && (
                      <div className="flex justify-between">
                        <span>공개일시</span>
                        <span className="text-status-ok">
                          {formatDateTime(pack.actual_release_at)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 팩 추가 모달 */}
      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 bg-bg-elevated border border-border rounded-xl p-6 shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
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
              취약점팩 추가
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-text-secondary">
              새로운 취약점팩의 정보를 입력하세요.
            </Dialog.Description>

            <div className="mt-4 space-y-4">
              {/* 팩 번호 + 공개 오프셋 */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-text-secondary mb-1 block">팩 번호</span>
                  <input
                    type="number"
                    min={1}
                    value={createForm.pack_number}
                    onChange={(e) =>
                      setCreateForm((f) => ({ ...f, pack_number: Number(e.target.value) }))
                    }
                    className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-text-secondary mb-1 block">공개 오프셋 (분)</span>
                  <input
                    type="number"
                    min={0}
                    step={30}
                    value={createForm.scheduled_offset_minutes}
                    onChange={(e) =>
                      setCreateForm((f) => ({
                        ...f,
                        scheduled_offset_minutes: Number(e.target.value),
                      }))
                    }
                    className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
                  />
                </label>
              </div>

              {/* 라벨 */}
              <label className="block">
                <span className="text-xs text-text-secondary mb-1 block">라벨</span>
                <input
                  type="text"
                  value={createForm.label}
                  onChange={(e) => setCreateForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="예: Pack Alpha — 웹 기초"
                  className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
                />
              </label>

              {/* 서비스 선택 (체크박스) */}
              <div>
                <span className="text-xs text-text-secondary mb-2 block">포함할 서비스 (활성 상태)</span>
                {approvedServices.length === 0 ? (
                  <p className="text-xs text-text-muted py-2">활성 상태의 서비스가 없습니다. 먼저 취약 서비스를 등록/빌드하여 활성화하세요.</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto space-y-1.5 bg-bg-secondary border border-border rounded-lg p-3">
                    {approvedServices.map((svc) => (
                      <label
                        key={svc.id}
                        className="flex items-center gap-2 text-sm text-text-primary cursor-pointer hover:bg-bg-tertiary/50 rounded px-1 py-0.5 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={createForm.service_ids.includes(svc.id)}
                          onChange={(e) => {
                            setCreateForm((f) => ({
                              ...f,
                              service_ids: e.target.checked
                                ? [...f.service_ids, svc.id]
                                : f.service_ids.filter((id) => id !== svc.id),
                            }));
                          }}
                          className="rounded border-border text-accent focus:ring-accent/50"
                        />
                        <span>{svc.name}</span>
                        <span className="text-xs text-text-muted ml-auto">{svc.category}</span>
                      </label>
                    ))}
                  </div>
                )}
                {createForm.service_ids.length > 0 && (
                  <p className="text-xs text-text-muted mt-1">
                    {createForm.service_ids.length}개 선택됨
                  </p>
                )}
              </div>
            </div>

            {/* 버튼 */}
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
                disabled={isCreating || !createForm.label.trim() || createForm.service_ids.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent/80 text-white transition-colors disabled:opacity-50"
              >
                {isCreating && <Loader2 className="w-4 h-4 animate-spin" />}
                추가
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
