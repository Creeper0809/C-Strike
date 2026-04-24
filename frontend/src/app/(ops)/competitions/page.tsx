"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, Trophy } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { COMPETITION_STATUS_MAP } from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import StatusIndicator from "@/components/ui/StatusIndicator";
import type { CompetitionListItem, CompetitionListResponse } from "@/types/ops";

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "draft", label: "초안" },
  { value: "registration", label: "등록 중" },
  { value: "ready", label: "준비 완료" },
  { value: "running", label: "진행 중" },
  { value: "paused", label: "일시중단" },
  { value: "finished", label: "종료" },
  { value: "archived", label: "아카이브" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

interface CreateFormData {
  name: string;
  description: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  scoring_round_interval_seconds: number;
  max_teams: number;
  max_members_per_team: number;
}

const INITIAL_FORM: CreateFormData = {
  name: "",
  description: "",
  scheduled_start_at: "",
  scheduled_end_at: "",
  scoring_round_interval_seconds: 120,
  max_teams: 20,
  max_members_per_team: 8,
};

function CreateModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<CreateFormData>({ ...INITIAL_FORM });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateField<K extends keyof CreateFormData>(key: K, value: CreateFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: form.name.trim() };
      if (form.description.trim()) body.description = form.description.trim();
      if (form.scheduled_start_at) body.scheduled_start_at = new Date(form.scheduled_start_at).toISOString();
      if (form.scheduled_end_at) body.scheduled_end_at = new Date(form.scheduled_end_at).toISOString();
      body.scoring_round_interval_seconds = form.scoring_round_interval_seconds;
      body.max_teams = form.max_teams;
      body.max_members_per_team = form.max_members_per_team;
      await apiFetch("/v1/competitions/", { method: "POST", body: JSON.stringify(body) });
      setForm({ ...INITIAL_FORM });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "생성에 실패했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!open) return null;

  const inputClass = "w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-bg-elevated border border-border rounded-xl p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-text-primary mb-4">새 대회 생성</h2>
        {error && (
          <div className="mb-4 rounded-lg bg-status-danger/10 border border-status-danger/30 px-3 py-2 text-sm text-status-danger">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm text-text-secondary">대회명 *</span>
            <input type="text" value={form.name} onChange={(e) => updateField("name", e.target.value)} placeholder="C-STRIKE 2026 본선" className={cn("mt-1", inputClass)} maxLength={200} required />
          </label>
          <label className="block">
            <span className="text-sm text-text-secondary">설명</span>
            <textarea value={form.description} onChange={(e) => updateField("description", e.target.value)} rows={2} className={cn("mt-1", inputClass)} />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm text-text-secondary">예정 시작</span>
              <input type="datetime-local" value={form.scheduled_start_at} onChange={(e) => updateField("scheduled_start_at", e.target.value)} className={cn("mt-1", inputClass)} />
            </label>
            <label className="block">
              <span className="text-sm text-text-secondary">예정 종료</span>
              <input type="datetime-local" value={form.scheduled_end_at} onChange={(e) => updateField("scheduled_end_at", e.target.value)} className={cn("mt-1", inputClass)} />
            </label>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <label className="block">
              <span className="text-sm text-text-secondary">라운드 간격 (초)</span>
              <input type="number" value={form.scoring_round_interval_seconds} onChange={(e) => updateField("scoring_round_interval_seconds", Number(e.target.value))} min={1} className={cn("mt-1", inputClass)} />
            </label>
            <label className="block">
              <span className="text-sm text-text-secondary">최대 팀 수</span>
              <input type="number" value={form.max_teams} onChange={(e) => updateField("max_teams", Number(e.target.value))} min={1} className={cn("mt-1", inputClass)} />
            </label>
            <label className="block">
              <span className="text-sm text-text-secondary">팀당 최대 인원</span>
              <input type="number" value={form.max_members_per_team} onChange={(e) => updateField("max_members_per_team", Number(e.target.value))} min={1} className={cn("mt-1", inputClass)} />
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors">취소</button>
            <button type="submit" disabled={isSubmitting || !form.name.trim()} className={cn("px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white transition-colors", isSubmitting || !form.name.trim() ? "opacity-50 cursor-not-allowed" : "hover:bg-accent/80")}>
              {isSubmitting ? "생성 중..." : "생성"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function CompetitionsPage() {
  const router = useRouter();
  const [data, setData] = useState<CompetitionListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);

  const fetchList = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("size", "20");
      const result = await apiFetch<CompetitionListResponse>(`/v1/competitions/?${params.toString()}`);
      setData(result);
    } catch {
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => { fetchList(); }, [fetchList]);

  function handleTabChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  const totalPages = data ? Math.ceil(data.total / 20) : 0;

  return (
    <div className="space-y-6">
      <PageHeader title="대회 관리" description="admin 전용 — 대회 생성, 수정, 상태 관리" actions={
        <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors">
          <Plus className="w-4 h-4" /> 새 대회
        </button>
      } />

      <div className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {STATUS_TABS.map((tab) => (
          <button key={tab.value} onClick={() => handleTabChange(tab.value)} className={cn(
            "px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
            statusFilter === tab.value ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text-secondary",
          )}>{tab.label}</button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      )}

      {!isLoading && data && data.items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <Trophy className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">등록된 대회가 없습니다.</p>
        </div>
      )}

      {!isLoading && data && data.items.length > 0 && (
        <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-4 py-3 font-medium">대회명</th>
                <th className="px-4 py-3 font-medium">상태</th>
                <th className="px-4 py-3 font-medium">예정 시작</th>
                <th className="px-4 py-3 font-medium">예정 종료</th>
                <th className="px-4 py-3 font-medium">최대 팀</th>
                <th className="px-4 py-3 font-medium">생성일</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((comp) => {
                const statusInfo = COMPETITION_STATUS_MAP[comp.status] || { label: comp.status, color: "neutral" as const };
                return (
                  <tr key={comp.id} onClick={() => router.push(`/competitions/${comp.id}`)} className="border-b border-border last:border-b-0 hover:bg-bg-tertiary cursor-pointer transition-colors">
                    <td className="px-4 py-3 font-medium text-text-primary">{comp.name}</td>
                    <td className="px-4 py-3"><StatusIndicator status={statusInfo.color} label={statusInfo.label} size="sm" /></td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(comp.scheduled_start_at)}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(comp.scheduled_end_at)}</td>
                    <td className="px-4 py-3 text-text-secondary">{comp.max_teams}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(comp.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && data && totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1.5 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors">이전</button>
          <span className="px-3 py-1.5 text-sm text-text-muted">{page} / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-1.5 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors">다음</button>
        </div>
      )}

      <CreateModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={fetchList} />
    </div>
  );
}
