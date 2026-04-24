"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Edit3, Loader2, Play, Pause, RotateCcw,
  Square, Archive, ChevronRight, Save, X, Trash2,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { COMPETITION_STATUS_MAP } from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import StatusIndicator from "@/components/ui/StatusIndicator";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type { Competition, CompetitionStatus, StateTransitionResponse } from "@/types/ops";

interface TransitionDef {
  action: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  variant: "default" | "danger";
  fromStatus: CompetitionStatus[];
  needsReason: boolean;
  confirmTitle: string;
  confirmDesc: string;
}

const TRANSITIONS: TransitionDef[] = [
  { action: "start", label: "대회 시작", icon: Play, variant: "default", fromStatus: ["ready"], needsReason: false, confirmTitle: "대회를 시작하시겠습니까?", confirmDesc: "승인된 팀과 활성 서비스가 1개 이상 존재해야 합니다. 시작 후에는 되돌릴 수 없습니다." },
  { action: "pause", label: "일시중단", icon: Pause, variant: "danger", fromStatus: ["running"], needsReason: true, confirmTitle: "대회를 일시중단하시겠습니까?", confirmDesc: "채점이 중지되고 참가자에게 알림이 전송됩니다." },
  { action: "resume", label: "재개", icon: RotateCcw, variant: "default", fromStatus: ["paused"], needsReason: true, confirmTitle: "대회를 재개하시겠습니까?", confirmDesc: "채점이 재개되고 참가자에게 알림이 전송됩니다." },
  { action: "finish", label: "대회 종료", icon: Square, variant: "danger", fromStatus: ["running"], needsReason: false, confirmTitle: "대회를 종료하시겠습니까?", confirmDesc: "채점 엔진이 정지되고 스코어보드가 최종 결과로 고정됩니다. 이 작업은 되돌릴 수 없습니다." },
  { action: "archive", label: "아카이브", icon: Archive, variant: "default", fromStatus: ["finished"], needsReason: false, confirmTitle: "대회를 아카이브하시겠습니까?", confirmDesc: "아카이브 후에도 데이터 조회는 가능합니다." },
];

const EARLY_TRANSITIONS: Record<string, { next: CompetitionStatus; label: string }> = {
  draft: { next: "registration", label: "등록 시작" },
  registration: { next: "ready", label: "등록 마감" },
};

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-text-primary">{value}</dd>
    </div>
  );
}

export default function CompetitionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const competitionId = params.id as string;

  const [comp, setComp] = useState<Competition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTransition, setActiveTransition] = useState<TransitionDef | null>(null);
  const [transitionReason, setTransitionReason] = useState("");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, unknown>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchDetail = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await apiFetch<Competition>(`/v1/competitions/${competitionId}`);
      setComp(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "조회에 실패했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [competitionId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  async function handleTransition() {
    if (!activeTransition || !comp) return;
    setIsTransitioning(true);
    try {
      const body = activeTransition.needsReason ? { reason: transitionReason } : undefined;
      await apiFetch<StateTransitionResponse>(
        `/v1/competitions/${comp.id}/${activeTransition.action}`,
        { method: "POST", body: body ? JSON.stringify(body) : undefined },
      );
      setActiveTransition(null);
      setTransitionReason("");
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "상태 전환에 실패했습니다.");
    } finally {
      setIsTransitioning(false);
    }
  }

  async function handleEarlyTransition(nextStatus: CompetitionStatus) {
    if (!comp) return;
    setIsTransitioning(true);
    try {
      await apiFetch<Competition>(`/v1/competitions/${comp.id}`, {
        method: "PATCH", body: JSON.stringify({ status: nextStatus }),
      });
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "상태 전환에 실패했습니다.");
    } finally {
      setIsTransitioning(false);
    }
  }

  function startEditing() {
    if (!comp) return;
    setEditForm({
      name: comp.name,
      description: comp.description || "",
      scoring_round_interval_seconds: comp.scoring_round_interval_seconds,
      max_teams: comp.max_teams,
      max_members_per_team: comp.max_members_per_team,
      network_participant_subnet: comp.network_participant_subnet || "",
      network_ops_subnet: comp.network_ops_subnet || "",
    });
    setIsEditing(true);
  }

  async function handleSave() {
    if (!comp) return;
    setIsSaving(true);
    setError(null);
    try {
      const changes: Record<string, unknown> = {};
      if (editForm.name !== comp.name) changes.name = editForm.name;
      if (editForm.description !== (comp.description || "")) changes.description = editForm.description || null;
      if (editForm.scoring_round_interval_seconds !== comp.scoring_round_interval_seconds) changes.scoring_round_interval_seconds = editForm.scoring_round_interval_seconds;
      if (editForm.max_teams !== comp.max_teams) changes.max_teams = editForm.max_teams;
      if (editForm.max_members_per_team !== comp.max_members_per_team) changes.max_members_per_team = editForm.max_members_per_team;
      if (editForm.network_participant_subnet !== (comp.network_participant_subnet || "")) changes.network_participant_subnet = editForm.network_participant_subnet;
      if (editForm.network_ops_subnet !== (comp.network_ops_subnet || "")) changes.network_ops_subnet = editForm.network_ops_subnet;
      if (Object.keys(changes).length === 0) { setIsEditing(false); return; }
      await apiFetch<Competition>(`/v1/competitions/${comp.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      setIsEditing(false);
      await fetchDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "수정에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!comp) return;
    setIsDeleting(true);
    try {
      await apiFetch(`/v1/competitions/${comp.id}`, { method: "DELETE" });
      router.push("/competitions");
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제에 실패했습니다.");
      setShowDeleteModal(false);
    } finally {
      setIsDeleting(false);
    }
  }

  const isDeletable = comp
    ? ["draft", "registration", "ready", "archived"].includes(comp.status)
    : false;

  if (isLoading) {
    return (<div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-text-muted" /></div>);
  }

  if (!comp) {
    return (
      <div className="space-y-6">
        <button onClick={() => router.push("/competitions")} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary"><ArrowLeft className="w-4 h-4" /> 목록으로</button>
        <div className="text-center py-20 text-status-danger">{error || "대회를 찾을 수 없습니다."}</div>
      </div>
    );
  }

  const statusInfo = COMPETITION_STATUS_MAP[comp.status] || { label: comp.status, color: "neutral" as const };
  const availableTransitions = TRANSITIONS.filter((t) => t.fromStatus.includes(comp.status as CompetitionStatus));
  const earlyTransition = EARLY_TRANSITIONS[comp.status];
  const inputClass = "w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <div className="space-y-6">
      <button onClick={() => router.push("/competitions")} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"><ArrowLeft className="w-4 h-4" /> 목록으로</button>

      <PageHeader title={comp.name} description={comp.description || undefined} actions={
        <div className="flex items-center gap-2">
          {!isEditing && (
            <>
              <button onClick={startEditing} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"><Edit3 className="w-4 h-4" /> 수정</button>
              {isDeletable && (
                <button onClick={() => setShowDeleteModal(true)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-status-danger/10 text-status-danger hover:bg-status-danger/20 transition-colors"><Trash2 className="w-4 h-4" /> 삭제</button>
              )}
            </>
          )}
        </div>
      } />

      {error && (
        <div className="rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
          {error} <button onClick={() => setError(null)} className="ml-2 underline">닫기</button>
        </div>
      )}

      <section className="bg-bg-secondary rounded-xl p-5 border border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <StatusIndicator status={statusInfo.color} label={statusInfo.label} />
            {comp.status === "running" && (<span className="text-sm text-text-muted">라운드 {comp.current_round} | 팀 {comp.team_count}개</span>)}
          </div>
          <div className="flex items-center gap-2">
            {earlyTransition && (
              <button onClick={() => handleEarlyTransition(earlyTransition.next)} disabled={isTransitioning} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50">
                <ChevronRight className="w-4 h-4" />{earlyTransition.label}
              </button>
            )}
            {availableTransitions.map((t) => {
              const Icon = t.icon;
              return (
                <button key={t.action} onClick={() => setActiveTransition(t)} className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
                  t.variant === "danger" ? "bg-status-danger/10 text-status-danger hover:bg-status-danger/20" : "bg-accent text-white hover:bg-accent/80",
                )}><Icon className="w-4 h-4" />{t.label}</button>
              );
            })}
          </div>
        </div>
      </section>

      {!isEditing && (
        <section className="bg-bg-secondary rounded-xl p-5 border border-border">
          <h2 className="text-sm font-semibold text-text-primary mb-4">대회 정보</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <InfoField label="대회명" value={comp.name} />
            <InfoField label="설명" value={comp.description || "-"} />
            <InfoField label="상태" value={statusInfo.label} />
            <InfoField label="예정 시작" value={formatDate(comp.scheduled_start_at)} />
            <InfoField label="예정 종료" value={formatDate(comp.scheduled_end_at)} />
            <InfoField label="실제 시작" value={formatDate(comp.actual_start_at)} />
            <InfoField label="실제 종료" value={formatDate(comp.actual_end_at)} />
            <InfoField label="라운드 간격" value={`${comp.scoring_round_interval_seconds}초`} />
            <InfoField label="최대 팀" value={`${comp.max_teams}팀`} />
            <InfoField label="팀당 최대 인원" value={`${comp.max_members_per_team}명`} />
            <InfoField label="참가자 네트워크" value={comp.network_participant_subnet} />
            <InfoField label="운영 네트워크" value={comp.network_ops_subnet} />
            <InfoField label="등록 팀" value={`${comp.team_count}팀`} />
            <InfoField label="현재 라운드" value={String(comp.current_round)} />
            <InfoField label="생성자" value={comp.created_by_name || "-"} />
            <InfoField label="생성일" value={formatDate(comp.created_at)} />
            <InfoField label="수정일" value={formatDate(comp.updated_at)} />
          </div>
        </section>
      )}

      <section className="bg-bg-secondary rounded-xl p-5 border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">팀 관리</h2>
            <p className="text-xs text-text-muted mt-1">등록된 팀 {comp.team_count}개</p>
          </div>
          <button onClick={() => router.push(`/competitions/${comp.id}/teams`)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors">
            팀 목록 보기 <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {isEditing && (
        <section className="bg-bg-secondary rounded-xl p-5 border border-border space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">대회 정보 수정</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setIsEditing(false)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"><X className="w-4 h-4" /> 취소</button>
              <button onClick={handleSave} disabled={isSaving} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"><Save className="w-4 h-4" /> {isSaving ? "저장 중..." : "저장"}</button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block"><span className="text-sm text-text-secondary">대회명</span><input type="text" value={String(editForm.name || "")} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} className={cn("mt-1", inputClass)} maxLength={200} /></label>
            <label className="block sm:col-span-2"><span className="text-sm text-text-secondary">설명</span><input type="text" value={String(editForm.description || "")} onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))} className={cn("mt-1", inputClass)} /></label>
            <label className="block"><span className="text-sm text-text-secondary">라운드 간격 (초)</span><input type="number" value={Number(editForm.scoring_round_interval_seconds || 120)} onChange={(e) => setEditForm((p) => ({ ...p, scoring_round_interval_seconds: Number(e.target.value) }))} min={1} className={cn("mt-1", inputClass)} /></label>
            <label className="block"><span className="text-sm text-text-secondary">최대 팀 수</span><input type="number" value={Number(editForm.max_teams || 20)} onChange={(e) => setEditForm((p) => ({ ...p, max_teams: Number(e.target.value) }))} min={1} className={cn("mt-1", inputClass)} /></label>
            <label className="block"><span className="text-sm text-text-secondary">팀당 최대 인원</span><input type="number" value={Number(editForm.max_members_per_team || 8)} onChange={(e) => setEditForm((p) => ({ ...p, max_members_per_team: Number(e.target.value) }))} min={1} className={cn("mt-1", inputClass)} /></label>
            <label className="block"><span className="text-sm text-text-secondary">참가자 네트워크 (서브넷)</span><input type="text" value={String(editForm.network_participant_subnet || "")} onChange={(e) => setEditForm((p) => ({ ...p, network_participant_subnet: e.target.value }))} placeholder="10.10.0.0/16" className={cn("mt-1", inputClass)} /></label>
            <label className="block"><span className="text-sm text-text-secondary">운영 네트워크 (서브넷)</span><input type="text" value={String(editForm.network_ops_subnet || "")} onChange={(e) => setEditForm((p) => ({ ...p, network_ops_subnet: e.target.value }))} placeholder="10.20.0.0/16" className={cn("mt-1", inputClass)} /></label>
          </div>
        </section>
      )}

      <ConfirmModal
        open={activeTransition !== null}
        onOpenChange={(open) => { if (!open) { setActiveTransition(null); setTransitionReason(""); } }}
        title={activeTransition?.confirmTitle || ""}
        description={activeTransition?.confirmDesc}
        confirmLabel={activeTransition?.label || "확인"}
        variant={activeTransition?.variant || "default"}
        onConfirm={handleTransition}
        isLoading={isTransitioning}
      >
        {activeTransition?.needsReason && (
          <label className="block mt-2">
            <span className="text-sm text-text-secondary">사유 *</span>
            <textarea value={transitionReason} onChange={(e) => setTransitionReason(e.target.value)} rows={2} className={cn("mt-1", inputClass)} placeholder="사유를 입력하세요" required />
          </label>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={showDeleteModal}
        onOpenChange={(open) => { if (!open) setShowDeleteModal(false); }}
        title="이 대회를 삭제하시겠습니까?"
        description={`"${comp.name}" 대회가 영구적으로 삭제됩니다. 관련된 팀, 설정 등 모든 데이터가 함께 삭제되며 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        variant="danger"
        onConfirm={handleDelete}
        isLoading={isDeleting}
      />
    </div>
  );
}
