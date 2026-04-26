"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Flag,
  Hammer,
  Loader2,
  Pencil,
  RefreshCw,
  Rocket,
  RotateCw,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  DEPLOY_STAGES,
  DEPLOY_STAGE_LABELS,
  FLAG_VERDICT_MAP,
  SERVICE_STATUS_MAP,
  STATUS_COLORS,
} from "@/lib/constants";
import type {
  DeployPipeline,
  FlagSlotConfig,
  FlagItem,
  FlagListResponse,
  FlagStatsResponse,
  FlagSubmissionItem,
  FlagSubmissionListResponse,
  VulnService,
} from "@/types/ops";
import PageHeader from "@/components/ui/PageHeader";
import FlagSlotEditor, { createDefaultFlagSlot } from "@/components/services/FlagSlotEditor";
import HealthCheckScenarioEditor from "@/components/services/HealthCheckScenarioEditor";
import HealthCheckScenarioPanel from "@/components/services/HealthCheckScenarioPanel";
import {
  extractHealthcheckScenarioDocument,
  type HealthcheckScenarioDocument,
} from "@/components/services/healthcheckScenarioUtils";

const CATEGORY_OPTIONS = [
  { value: "web", label: "웹" },
  { value: "pwn", label: "포너블" },
  { value: "crypto", label: "암호학" },
  { value: "reversing", label: "리버싱" },
  { value: "misc", label: "기타" },
] as const;

interface CompetitionOption {
  id: string;
  name: string;
  status: string;
}

interface PipelineListItem {
  id: string;
  service_id: string;
  triggered_by: string;
  triggered_by_name: string | null;
  service_name: string | null;
  status: string;
  current_stage: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
}

interface ToastItem {
  id: string;
  message: string;
  type: "building" | "success" | "error";
}

type FlagTabKey = "list" | "submissions" | "stats";
type ServiceDetailTabKey = "overview" | "healthcheck" | "deploy" | "flags" | "build";
type EditMode = "service" | "healthcheck" | "flags";
type ServiceEnvironmentType = "dockerfile" | "image" | "connection_info";

const ENV_TYPE_LABELS: Record<ServiceEnvironmentType, string> = {
  image: "Docker 이미지",
  dockerfile: "Dockerfile 업로드",
  connection_info: "접속 정보",
};

const FLAG_TAB_OPTIONS: Array<{ key: FlagTabKey; label: string }> = [
  { key: "list", label: "플래그 목록" },
  { key: "submissions", label: "제출 기록" },
  { key: "stats", label: "서비스 통계" },
];

const SERVICE_DETAIL_TABS: Array<{
  key: ServiceDetailTabKey;
  label: string;
  icon: typeof Shield;
}> = [
  { key: "overview", label: "개요", icon: Shield },
  { key: "healthcheck", label: "헬스체크", icon: Activity },
  { key: "deploy", label: "배포", icon: Rocket },
  { key: "flags", label: "플래그", icon: Flag },
  { key: "build", label: "빌드", icon: Hammer },
];

const DEPLOY_STATUS_MAP: Record<
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
  scheduled: {
    label: "예약됨",
    color: "text-status-warning",
    bg: "bg-status-warning/10",
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

const STATUS_BADGE_BG: Record<string, string> = {
  ok: "bg-status-ok/15",
  warning: "bg-status-warning/15",
  danger: "bg-status-danger/15",
  info: "bg-status-info/15",
  neutral: "bg-bg-tertiary",
};

function StatusBadge({ status }: { status: string }) {
  const mapped = SERVICE_STATUS_MAP[status] ?? {
    label: status,
    color: "neutral" as const,
  };
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
        STATUS_COLORS[mapped.color],
        STATUS_BADGE_BG[mapped.color],
      )}
    >
      {mapped.label}
    </span>
  );
}

function DeployStatusBadge({ status }: { status: string }) {
  const mapped = DEPLOY_STATUS_MAP[status] ?? DEPLOY_STATUS_MAP.pending;
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
        mapped.color,
        mapped.bg,
      )}
    >
      {mapped.label}
    </span>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateTimeLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getVerdictInfo(verdict: string) {
  return FLAG_VERDICT_MAP[verdict] ?? { label: verdict, color: "neutral" as const };
}

function getScenarioStepCount(value: Record<string, unknown> | null | undefined): number {
  if (!value || typeof value !== "object") return 0;
  const steps = (value as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps.length : 0;
}

export default function ServiceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const serviceId = Array.isArray(params.id) ? params.id[0] : params.id;
  const backHref = useMemo(() => {
    const query = searchParams.toString();
    return query ? `/services?${query}` : "/services";
  }, [searchParams]);

  const [service, setService] = useState<VulnService | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [competitions, setCompetitions] = useState<CompetitionOption[]>([]);
  const [isLinkingCompetition, setIsLinkingCompetition] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deployPipelines, setDeployPipelines] = useState<PipelineListItem[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [selectedPipeline, setSelectedPipeline] = useState<DeployPipeline | null>(null);
  const [selectedDeployStage, setSelectedDeployStage] = useState<string | null>(null);
  const [isDeployLoading, setIsDeployLoading] = useState(false);
  const [showDeployHistory, setShowDeployHistory] = useState(false);
  const [scheduleDeployOpen, setScheduleDeployOpen] = useState(false);
  const [scheduledForInput, setScheduledForInput] = useState(() => {
    const base = new Date(Date.now() + 10 * 60 * 1000);
    base.setSeconds(0, 0);
    return formatDateTimeLocalInput(base);
  });
  const [editOpen, setEditOpen] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>("service");
  const [editForm, setEditForm] = useState<{
    name: string;
    description: string;
    connection_info: string;
    category: string;
    docker_image: string;
    flag_slots: FlagSlotConfig[];
    health_check_endpoint: string;
    healthcheck_scenarios: HealthcheckScenarioDocument | null;
  } | null>(null);
  const [isEditSubmitting, setIsEditSubmitting] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [activeDetailTab, setActiveDetailTab] = useState<ServiceDetailTabKey>("overview");
  const [activeFlagTab, setActiveFlagTab] = useState<FlagTabKey>("list");
  const [flagItems, setFlagItems] = useState<FlagItem[]>([]);
  const [flagTotal, setFlagTotal] = useState(0);
  const [flagPage, setFlagPage] = useState(1);
  const [isFlagsLoading, setIsFlagsLoading] = useState(false);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [flagRoundFilter, setFlagRoundFilter] = useState("");
  const [flagActiveFilter, setFlagActiveFilter] = useState("");
  const [submissionItems, setSubmissionItems] = useState<FlagSubmissionItem[]>([]);
  const [submissionTotal, setSubmissionTotal] = useState(0);
  const [submissionPage, setSubmissionPage] = useState(1);
  const [isSubmissionsLoading, setIsSubmissionsLoading] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submissionRoundFilter, setSubmissionRoundFilter] = useState("");
  const [submissionVerdictFilter, setSubmissionVerdictFilter] = useState("");
  const [submissionSubmitterFilter, setSubmissionSubmitterFilter] = useState("");
  const [submissionTargetFilter, setSubmissionTargetFilter] = useState("");
  const [flagStats, setFlagStats] = useState<FlagStatsResponse | null>(null);
  const [isFlagStatsLoading, setIsFlagStatsLoading] = useState(false);
  const [flagStatsError, setFlagStatsError] = useState<string | null>(null);

  function addToast(message: string, type: ToastItem["type"], id?: string): string {
    const toastId = id ?? crypto.randomUUID();
    setToasts((prev) => {
      const idx = prev.findIndex((t) => t.id === toastId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { id: toastId, message, type };
        return next;
      }
      return [...prev, { id: toastId, message, type }];
    });
    if (type !== "building") {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toastId));
      }, type === "error" ? 10_000 : 5_000);
    }
    return toastId;
  }

  const fetchService = useCallback(async () => {
    if (!serviceId) return;
    setIsLoading(true);
    try {
      const data = await apiFetch<VulnService>(`/services/${serviceId}`);
      setService(data);
    } catch {
      setService(null);
    } finally {
      setIsLoading(false);
    }
  }, [serviceId]);

  const fetchCompetitions = useCallback(async () => {
    try {
      const data = await apiFetch<{ items: CompetitionOption[] }>(
        "/v1/competitions/?size=100",
      );
      setCompetitions(data.items ?? []);
    } catch {
      setCompetitions([]);
    }
  }, []);

  const fetchDeployPipelines = useCallback(async (targetServiceId: string) => {
    setIsDeployLoading(true);
    try {
      const data = await apiFetch<{ items: PipelineListItem[]; total: number }>(
        `/deploy/pipelines?service_id=${targetServiceId}&page=1&limit=5`,
      );
      const items = data.items ?? [];
      setDeployPipelines(items);
      setSelectedPipelineId((prev) =>
        prev && items.some((item) => item.id === prev) ? prev : (items[0]?.id ?? null),
      );
    } catch {
      setDeployPipelines([]);
      setSelectedPipelineId(null);
      setSelectedPipeline(null);
      setSelectedDeployStage(null);
    } finally {
      setIsDeployLoading(false);
    }
  }, []);

  const fetchFlags = useCallback(async () => {
    if (!service?.competition_id) return;
    setIsFlagsLoading(true);
    setFlagError(null);
    try {
      const params = new URLSearchParams({
        page: String(flagPage),
        size: "10",
        service_id: service.id,
      });
      if (flagRoundFilter.trim()) params.set("round_number", flagRoundFilter.trim());
      if (flagActiveFilter) params.set("is_active", flagActiveFilter);
      const data = await apiFetch<FlagListResponse>(
        `/v1/competitions/${service.competition_id}/flags/?${params.toString()}`,
      );
      setFlagItems(data.items);
      setFlagTotal(data.total);
    } catch (err) {
      setFlagError(err instanceof Error ? err.message : "플래그 목록을 불러오지 못했습니다.");
      setFlagItems([]);
      setFlagTotal(0);
    } finally {
      setIsFlagsLoading(false);
    }
  }, [service?.competition_id, service?.id, flagPage, flagRoundFilter, flagActiveFilter]);

  const fetchSubmissions = useCallback(async () => {
    if (!service?.competition_id) return;
    setIsSubmissionsLoading(true);
    setSubmissionError(null);
    try {
      const params = new URLSearchParams({
        page: String(submissionPage),
        size: "10",
        service_id: service.id,
      });
      if (submissionRoundFilter.trim()) params.set("round_number", submissionRoundFilter.trim());
      if (submissionVerdictFilter) params.set("verdict", submissionVerdictFilter);
      if (submissionSubmitterFilter.trim()) {
        params.set("submitter_team_name", submissionSubmitterFilter.trim());
      }
      if (submissionTargetFilter.trim()) {
        params.set("target_team_name", submissionTargetFilter.trim());
      }
      const data = await apiFetch<FlagSubmissionListResponse>(
        `/v1/competitions/${service.competition_id}/flags/submissions?${params.toString()}`,
      );
      setSubmissionItems(data.items);
      setSubmissionTotal(data.total);
    } catch (err) {
      setSubmissionError(err instanceof Error ? err.message : "제출 기록을 불러오지 못했습니다.");
      setSubmissionItems([]);
      setSubmissionTotal(0);
    } finally {
      setIsSubmissionsLoading(false);
    }
  }, [
    service?.competition_id,
    service?.id,
    submissionPage,
    submissionRoundFilter,
    submissionVerdictFilter,
    submissionSubmitterFilter,
    submissionTargetFilter,
  ]);

  const fetchFlagStats = useCallback(async () => {
    if (!service?.competition_id) return;
    setIsFlagStatsLoading(true);
    setFlagStatsError(null);
    try {
      const data = await apiFetch<FlagStatsResponse>(
        `/v1/competitions/${service.competition_id}/flags/stats?service_id=${service.id}`,
      );
      setFlagStats(data);
    } catch (err) {
      setFlagStatsError(err instanceof Error ? err.message : "플래그 통계를 불러오지 못했습니다.");
      setFlagStats(null);
    } finally {
      setIsFlagStatsLoading(false);
    }
  }, [service?.competition_id, service?.id]);

  useEffect(() => {
    fetchService();
    fetchCompetitions();
  }, [fetchService, fetchCompetitions]);

  useEffect(() => {
    setFlagPage(1);
    setSubmissionPage(1);
  }, [service?.id]);

  useEffect(() => {
    if (!service?.id) {
      setDeployPipelines([]);
      setSelectedPipelineId(null);
      setSelectedPipeline(null);
      setSelectedDeployStage(null);
      setShowDeployHistory(false);
      return;
    }
    setShowDeployHistory(false);
    fetchDeployPipelines(service.id);
  }, [service?.id, fetchDeployPipelines]);

  useEffect(() => {
    if (!selectedPipelineId) {
      setSelectedPipeline(null);
      setSelectedDeployStage(null);
      return;
    }

    let cancelled = false;

    async function loadPipelineDetail() {
      setIsDeployLoading(true);
      try {
        const detail = await apiFetch<DeployPipeline>(
          `/deploy/pipelines/${selectedPipelineId}`,
        );
        if (cancelled) return;
        setSelectedPipeline(detail);
        setSelectedDeployStage(
          detail.current_stage ?? detail.stages[0]?.stage_name ?? null,
        );
      } catch {
        if (cancelled) return;
        setSelectedPipeline(null);
        setSelectedDeployStage(null);
      } finally {
        if (!cancelled) setIsDeployLoading(false);
      }
    }

    loadPipelineDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId]);

  useEffect(() => {
    if (activeFlagTab === "list") {
      fetchFlags();
    }
  }, [activeFlagTab, fetchFlags]);

  useEffect(() => {
    if (activeFlagTab === "submissions") {
      fetchSubmissions();
    }
  }, [activeFlagTab, fetchSubmissions]);

  useEffect(() => {
    if (activeFlagTab === "stats") {
      fetchFlagStats();
    }
  }, [activeFlagTab, fetchFlagStats]);

  const selectedDeployStageDetail =
    selectedPipeline && selectedDeployStage
      ? selectedPipeline.stages.find((stage) => stage.stage_name === selectedDeployStage) ?? null
      : null;
  const latestPipeline = deployPipelines[0] ?? null;
  const historyPipelines = latestPipeline
    ? deployPipelines.filter((pipeline) => pipeline.id !== latestPipeline.id)
    : [];
  const flagTotalPages = Math.max(1, Math.ceil(flagTotal / 10));
  const submissionTotalPages = Math.max(1, Math.ceil(submissionTotal / 10));
  const currentServiceStats =
    service?.id != null
      ? flagStats?.service_stats.find((item) => item.service_id === service.id) ?? null
      : null;
  const editTotalPoints =
    editForm?.flag_slots.reduce((sum, slot) => sum + (Number(slot.points) || 0), 0) ?? 0;

  function openEdit(target: VulnService, mode: EditMode) {
    setEditForm({
      name: target.name,
      description: target.description ?? "",
      connection_info: target.connection_info ?? "",
      category: target.category,
      docker_image: target.docker_image ?? "",
      flag_slots: target.flag_slots?.length ? target.flag_slots.map((slot) => ({ ...slot })) : [createDefaultFlagSlot(1, target.score ?? 100)],
      health_check_endpoint: target.health_check_endpoint ?? "",
      healthcheck_scenarios: extractHealthcheckScenarioDocument(target.healthcheck_scenarios),
    });
    setEditMode(mode);
    setEditOpen(true);
  }

  async function handleLinkCompetition(competitionId: string | null) {
    if (!service) return;
    setIsLinkingCompetition(true);
    try {
      const updated = await apiFetch<VulnService>(`/services/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify({ competition_id: competitionId }),
      });
      setService(updated);
    } catch (err) {
      alert(`대회 연결 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
    } finally {
      setIsLinkingCompetition(false);
    }
  }

  async function handleEditSubmit() {
    if (!service || !editForm) return;
    setIsEditSubmitting(true);
    try {
      let body: Record<string, unknown>;
      if (editMode === "service") {
        body = service.status === "draft"
          ? {
              name: editForm.name.trim(),
              category: editForm.category,
              description: editForm.description.trim() || null,
              connection_info: editForm.connection_info.trim() || null,
              docker_image: editForm.docker_image.trim() || null,
            }
          : {
              connection_info: editForm.connection_info.trim() || null,
            };
      } else if (editMode === "healthcheck") {
        body = {
          health_check_endpoint: editForm.health_check_endpoint.trim() || null,
          healthcheck_scenarios: editForm.healthcheck_scenarios,
        };
      } else {
        body = {
          flag_slots: editForm.flag_slots,
        };
      }
      const updated = await apiFetch<VulnService>(`/services/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setService(updated);
      setEditOpen(false);
      setEditForm(null);
    } catch (err) {
      alert(`수정 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
    } finally {
      setIsEditSubmitting(false);
    }
  }

  async function handleActivate() {
    if (!service) return;
    setActionLoading("activate");
    try {
      const updated = await apiFetch<VulnService>(`/services/${service.id}/activate`, {
        method: "POST",
      });
      setService(updated);
    } catch (err) {
      alert(`활성화 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function pollBuildResult(id: string, maxSeconds = 600): Promise<VulnService | null> {
    const pollInterval = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxSeconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      try {
        const svc = await apiFetch<VulnService>(`/services/${id}`);
        if (svc.build_status === "success" || svc.build_status === "failed") {
          return svc;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async function handleBuild() {
    if (!service) return;
    setActionLoading("build");
    try {
      const result = await apiFetch<{ build_status: string; message: string }>(
        `/services/${service.id}/build`,
        { method: "POST" },
      );
      const refreshed = await apiFetch<VulnService>(`/services/${service.id}`);
      setService(refreshed);
      if (result.build_status !== "success") {
        alert(`빌드 실패: ${result.message || "알 수 없음"}`);
      }
    } catch (err) {
      const finalSvc = await pollBuildResult(service.id);
      if (finalSvc) {
        setService(finalSvc);
        if (finalSvc.build_status === "failed") {
          alert(`빌드 실패: ${finalSvc.build_log || "알 수 없음"}`);
        }
      } else {
        alert(
          `빌드 상태를 확인할 수 없습니다. 잠시 후 새로고침하세요.\n${
            err instanceof Error ? err.message : "알 수 없는 오류"
          }`,
        );
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDeploy() {
    if (!service) return;
    setActionLoading("deploy");
    try {
      await apiFetch("/deploy/pipelines", {
        method: "POST",
        body: JSON.stringify({ service_id: service.id }),
      });
      addToast(`"${service.name}" 배포를 시작했습니다.`, "success");
      await fetchDeployPipelines(service.id);
    } catch (err) {
      addToast(
        `"${service.name}" 배포 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        "error",
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function handleScheduleDeploy() {
    if (!service) return;
    if (!scheduledForInput) {
      addToast("예약 시간을 입력해 주세요.", "error");
      return;
    }

    const scheduledDate = new Date(scheduledForInput);
    if (Number.isNaN(scheduledDate.getTime())) {
      addToast("예약 시간이 올바르지 않습니다.", "error");
      return;
    }
    if (scheduledDate.getTime() <= Date.now()) {
      addToast("예약 시간은 현재 시각보다 이후여야 합니다.", "error");
      return;
    }

    setActionLoading("schedule-deploy");
    try {
      await apiFetch("/deploy/pipelines", {
        method: "POST",
        body: JSON.stringify({
          service_id: service.id,
          scheduled_for: scheduledDate.toISOString(),
        }),
      });
      addToast(
        `"${service.name}" 배포를 ${formatDateTime(scheduledDate.toISOString())}에 예약했습니다.`,
        "success",
      );
      setScheduleDeployOpen(false);
      await fetchDeployPipelines(service.id);
    } catch (err) {
      addToast(
        `"${service.name}" 예약 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        "error",
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete() {
    if (!service) return;
    setActionLoading("delete");
    try {
      await apiFetch(`/services/${service.id}`, { method: "DELETE" });
      router.push(backHref);
    } finally {
      setActionLoading(null);
    }
  }

  if (isLoading && !service) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="문제 상세"
          description="문제 정보를 불러오는 중입니다."
          actions={
            <button
              type="button"
              onClick={() => router.push(backHref)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary"
            >
              <ArrowLeft className="w-4 h-4" />
              목록으로
            </button>
          }
        />
        <div className="rounded-xl border border-border bg-bg-secondary p-8 text-sm text-text-muted">
          문제 정보를 불러오는 중...
        </div>
      </div>
    );
  }

  if (!service) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="문제 상세"
          description="문제를 찾을 수 없습니다."
          actions={
            <button
              type="button"
              onClick={() => router.push(backHref)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary"
            >
              <ArrowLeft className="w-4 h-4" />
              목록으로
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={service.name}
        description="문제 설정, 플래그 슬롯, 배포 상태, 플래그 이력을 여기서 관리합니다."
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={service.status} />
            <button
              type="button"
              onClick={() => router.push(backHref)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary"
            >
              <ArrowLeft className="w-4 h-4" />
              목록으로
            </button>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <div className="overflow-x-auto border-b border-border">
            <div className="flex min-w-max gap-1">
              {SERVICE_DETAIL_TABS.map((tab) => {
                const TabIcon = tab.icon;
                const isActive = activeDetailTab === tab.key;
                const countLabel =
                  tab.key === "deploy"
                    ? `${deployPipelines.length}`
                    : tab.key === "flags"
                      ? `${service.flag_slots.length}`
                      : tab.key === "healthcheck"
                        ? `${getScenarioStepCount(service.healthcheck_scenarios)} step`
                        : null;

                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveDetailTab(tab.key)}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-t-lg border-b-2 px-3 py-2 text-sm transition-colors",
                      isActive
                        ? "border-accent text-accent"
                        : "border-transparent text-text-muted hover:text-text-primary",
                    )}
                  >
                    <TabIcon className="w-4 h-4" />
                    {tab.label}
                    {countLabel && <span className="text-xs text-text-muted">{countLabel}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {activeDetailTab === "overview" && (
            <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-text-primary">기본 정보</h2>
              <button
                type="button"
                onClick={() => openEdit(service, "service")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25"
              >
                <Pencil className="w-4 h-4" />
                {service.status === "draft" ? "문제 수정" : "접속 정보 수정"}
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <DetailRow label="카테고리" value={service.category} />
              <DetailRow label="환경 타입" value={ENV_TYPE_LABELS[service.env_type]} />
              <DetailRow label="버전" value={`v${service.version}`} />
              <DetailRow label="점수" value={String(service.score)} />
              {service.env_type !== "connection_info" && (
                <DetailRow label="Docker 이미지" value={service.docker_image ?? "-"} mono />
              )}
              <DetailRow
                label="헬스체크 방식"
                value={
                  getScenarioStepCount(service.healthcheck_scenarios)
                    ? "시나리오 기반 검증"
                    : service.health_check_endpoint
                      ? "엔드포인트 기반 검증"
                      : "TCP 연결 체크"
                }
              />
              <DetailRow label="등록자" value={service.registered_by_name ?? service.registered_by} />
              <DetailRow label="등록일" value={formatDate(service.created_at)} />
              <DetailRow label="승인자" value={service.approved_by_name ?? service.approved_by ?? "-"} />
              <DetailRow label="승인일" value={formatDate(service.approved_at)} />
            </div>

            <div className="rounded-lg border border-border/60 bg-bg-tertiary/30 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-text-primary">접속 정보</h3>
                <span className="text-xs text-text-muted">참가자 안내</span>
              </div>
              {service.connection_info ? (
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-bg-secondary px-3 py-3 text-sm text-text-secondary">
                  {service.connection_info}
                </pre>
              ) : (
                <p className="text-sm text-text-muted">아직 저장된 접속 정보가 없습니다.</p>
              )}
            </div>

            <div className="rounded-lg border border-border/60 bg-bg-tertiary/30 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-text-primary">플래그 슬롯</h3>
                <span className="text-xs text-text-muted">{service.flag_slots.length}개</span>
              </div>
              <div className="space-y-2">
                {service.flag_slots.map((slot, index) => (
                  <div
                    key={`${slot.slot_key ?? "slot"}-${index}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-bg-secondary px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{slot.label}</span>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                          {slot.difficulty}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-text-muted">{slot.filename}</div>
                    </div>
                    <div className="text-sm font-medium text-text-secondary">{slot.points}점</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-border/50">
              <div className="flex items-center justify-between mb-1">
                <span className="text-text-muted text-xs uppercase tracking-wider">
                  귀속 대회
                </span>
                {!service.competition_id && (
                  <span className="text-xs text-status-warning">미지정 · 배포 불가</span>
                )}
              </div>
              {competitions.length === 0 ? (
                <div className="form-input text-sm text-text-muted">
                  등록된 대회가 없습니다. 먼저 운영용 대회를 준비하세요.
                </div>
              ) : (
                <select
                  value={service.competition_id ?? ""}
                  disabled={isLinkingCompetition}
                  onChange={(e) => handleLinkCompetition(e.target.value || null)}
                  className="form-input text-sm"
                >
                  <option value="">미지정</option>
                  {competitions.map((competition) => (
                    <option key={competition.id} value={competition.id}>
                      {competition.name} ({competition.status})
                    </option>
                  ))}
                </select>
              )}
              {isLinkingCompetition && (
                <p className="text-xs text-text-muted mt-1">대회 연결 중...</p>
              )}
            </div>

            {service.description && (
              <div className="pt-2 border-t border-border/50">
                <span className="text-text-muted text-xs uppercase tracking-wider">설명</span>
                <p className="mt-2 text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                  {service.description}
                </p>
              </div>
            )}
            </section>
          )}

          {activeDetailTab === "healthcheck" && (
            <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-text-primary">헬스체크</h2>
                  <p className="text-sm text-text-muted">
                    이 문제의 검증 방식과 시나리오 step을 확인합니다.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openEdit(service, "healthcheck")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25"
                >
                  <Pencil className="w-4 h-4" />
                  헬스체크 수정
                </button>
              </div>

              <HealthCheckScenarioPanel
                endpoint={service.health_check_endpoint}
                scenarios={service.healthcheck_scenarios}
              />
            </section>
          )}

          {activeDetailTab === "deploy" && (
            <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">배포 현황</h2>
              {service.competition_id && (
                <button
                  type="button"
                  onClick={() => fetchDeployPipelines(service.id)}
                  disabled={isDeployLoading}
                  className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={cn("w-3 h-3", isDeployLoading && "animate-spin")} />
                  새로고침
                </button>
              )}
            </div>

            {!service.competition_id ? (
              <p className="text-sm text-text-muted">
                귀속 대회를 지정해야 배포 이력과 현재 상태를 확인할 수 있습니다.
              </p>
            ) : isDeployLoading && deployPipelines.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                배포 이력을 불러오는 중...
              </div>
            ) : deployPipelines.length === 0 ? (
              <p className="text-sm text-text-muted">
                아직 배포 이력이 없습니다. 활성 문제라면 우측에서 바로 배포를 시작할 수 있습니다.
              </p>
            ) : (
              <div className="space-y-4">
                {latestPipeline && (
                  <div className="rounded-lg border border-border bg-bg-tertiary p-4 space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-text-primary">
                          {selectedPipeline?.id === latestPipeline.id ? "최근 배포" : "선택한 배포"}
                        </p>
                        <p className="text-[11px] font-mono text-text-muted">
                          {selectedPipeline?.id ?? latestPipeline.id}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedPipeline?.id !== latestPipeline.id && (
                          <button
                            type="button"
                            onClick={() => setSelectedPipelineId(latestPipeline.id)}
                            className="text-xs text-accent hover:underline"
                          >
                            최신으로 돌아가기
                          </button>
                        )}
                        <DeployStatusBadge status={selectedPipeline?.status ?? latestPipeline.status} />
                      </div>
                    </div>

                    {selectedPipeline && (
                      <>
                        <div className="grid gap-3 md:grid-cols-2">
                          <DetailRow
                            label="현재 단계"
                            value={
                              selectedPipeline.current_stage
                                ? DEPLOY_STAGE_LABELS[selectedPipeline.current_stage] ?? selectedPipeline.current_stage
                                : "-"
                            }
                          />
                          <DetailRow
                            label="실행자"
                            value={selectedPipeline.triggered_by_name ?? selectedPipeline.triggered_by}
                          />
                          <DetailRow
                            label={selectedPipeline.status === "scheduled" ? "예약 시각" : "시작"}
                            value={formatDateTime(
                              selectedPipeline.status === "scheduled"
                                ? selectedPipeline.scheduled_for
                                : selectedPipeline.started_at,
                            )}
                          />
                          <DetailRow label="완료" value={formatDateTime(selectedPipeline.completed_at)} />
                        </div>

                        {selectedPipeline.error_detail && (
                          <div className="rounded-lg border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-xs text-status-danger whitespace-pre-wrap break-words">
                            {selectedPipeline.error_detail}
                          </div>
                        )}

                        <div className="space-y-2">
                          <span className="text-text-muted text-xs uppercase tracking-wider">
                            파이프라인 단계
                          </span>
                          <div className="grid gap-2">
                            {DEPLOY_STAGES.map((stageName) => {
                              const stage =
                                selectedPipeline.stages.find((item) => item.stage_name === stageName) ?? null;
                              const stageStatus = stage?.status ?? "pending";
                              return (
                                <button
                                  key={stageName}
                                  type="button"
                                  onClick={() => setSelectedDeployStage(stageName)}
                                  className={cn(
                                    "rounded-lg border px-3 py-2 text-left transition-colors",
                                    selectedDeployStage === stageName
                                      ? "border-accent bg-accent/10"
                                      : "border-border bg-bg-secondary hover:border-accent/40",
                                  )}
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="text-sm text-text-primary">
                                      {DEPLOY_STAGE_LABELS[stageName] ?? stageName}
                                    </span>
                                    <DeployStatusBadge status={stageStatus} />
                                  </div>
                                  <div className="mt-1 text-[11px] text-text-muted font-mono">
                                    {stage?.started_at
                                      ? `${formatDateTime(stage.started_at)}${
                                          stage?.completed_at ? ` -> ${formatDateTime(stage.completed_at)}` : ""
                                        }`
                                      : "아직 실행되지 않음"}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {selectedDeployStage && (
                          <div className="space-y-2 rounded-lg border border-border bg-bg-secondary p-3">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm font-medium text-text-primary">
                                {DEPLOY_STAGE_LABELS[selectedDeployStage] ?? selectedDeployStage}
                              </span>
                              <DeployStatusBadge status={selectedDeployStageDetail?.status ?? "pending"} />
                            </div>
                            <div className="grid gap-3 md:grid-cols-2">
                              <DetailRow
                                label="시작"
                                value={formatDateTime(selectedDeployStageDetail?.started_at ?? null)}
                              />
                              <DetailRow
                                label="완료"
                                value={formatDateTime(selectedDeployStageDetail?.completed_at ?? null)}
                              />
                            </div>
                            <pre className="max-h-56 overflow-auto rounded-lg bg-bg-primary px-3 py-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words">
{selectedDeployStageDetail?.log_output
  || selectedDeployStageDetail?.error_detail
  || "기록된 로그가 없습니다."}
                            </pre>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {historyPipelines.length > 0 && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowDeployHistory((prev) => {
                          const next = !prev;
                          if (!next && latestPipeline) {
                            setSelectedPipelineId(latestPipeline.id);
                          }
                          return next;
                        });
                      }}
                      className="text-xs text-text-muted hover:text-text-primary transition-colors"
                    >
                      {showDeployHistory
                        ? "이전 이력 숨기기"
                        : `이전 이력 ${historyPipelines.length}건 보기`}
                    </button>

                    {showDeployHistory && (
                      <div className="flex flex-wrap gap-2">
                        {historyPipelines.map((pipeline) => (
                          <button
                            key={pipeline.id}
                            type="button"
                            onClick={() => setSelectedPipelineId(pipeline.id)}
                            className={cn(
                              "rounded-lg border px-2.5 py-2 text-left transition-colors",
                              selectedPipelineId === pipeline.id
                                ? "border-accent bg-accent/10"
                                : "border-border bg-bg-tertiary hover:border-accent/40",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <DeployStatusBadge status={pipeline.status} />
                              <span className="text-[11px] font-mono text-text-muted">
                                {pipeline.id.slice(0, 8)}
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] text-text-secondary">
                              {pipeline.status === "scheduled"
                                ? "예약 배포"
                                : pipeline.current_stage
                                ? DEPLOY_STAGE_LABELS[pipeline.current_stage] ?? pipeline.current_stage
                                : "단계 정보 없음"}
                            </div>
                            <div className="mt-0.5 text-[11px] text-text-muted font-mono">
                              {formatDateTime(
                                pipeline.status === "scheduled"
                                  ? pipeline.scheduled_for
                                  : (pipeline.started_at ?? pipeline.created_at),
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            </section>
          )}

          {activeDetailTab === "flags" && (
            <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-text-primary">플래그</h2>
                <p className="text-sm text-text-muted">
                  이 문제에 연결된 플래그와 제출 기록을 확인합니다.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openEdit(service, "flags")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25"
                >
                  <Pencil className="w-4 h-4" />
                  플래그 수정
                </button>
                {service.competition_id && (
                  <button
                    type="button"
                    onClick={() => {
                      if (activeFlagTab === "list") fetchFlags();
                      if (activeFlagTab === "submissions") fetchSubmissions();
                      if (activeFlagTab === "stats") fetchFlagStats();
                    }}
                    className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
                  >
                    <RefreshCw
                      className={cn(
                        "w-3 h-3",
                        (isFlagsLoading || isSubmissionsLoading || isFlagStatsLoading) && "animate-spin",
                      )}
                    />
                    새로고침
                  </button>
                )}
              </div>
            </div>

            {!service.competition_id ? (
              <p className="text-sm text-text-muted">
                귀속 대회를 지정해야 플래그 데이터를 확인할 수 있습니다.
              </p>
            ) : (
              <>
                <div className="border-b border-border">
                  <nav className="flex gap-0 -mb-px">
                    {FLAG_TAB_OPTIONS.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setActiveFlagTab(tab.key)}
                        className={cn(
                          "px-4 py-2 text-sm font-medium transition-colors border-b-2",
                          activeFlagTab === tab.key
                            ? "border-accent text-accent"
                            : "border-transparent text-text-muted hover:text-text-secondary hover:border-border",
                        )}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </nav>
                </div>

                {activeFlagTab === "list" && (
                  <div className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[120px_140px_auto]">
                      <label className="block">
                        <span className="text-xs text-text-muted mb-1 block">라운드</span>
                        <input
                          type="number"
                          value={flagRoundFilter}
                          onChange={(e) => {
                            setFlagRoundFilter(e.target.value);
                            setFlagPage(1);
                          }}
                          className="form-input"
                          placeholder="라운드 번호"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-text-muted mb-1 block">활성 상태</span>
                        <select
                          value={flagActiveFilter}
                          onChange={(e) => {
                            setFlagActiveFilter(e.target.value);
                            setFlagPage(1);
                          }}
                          className="form-input"
                        >
                          <option value="">전체</option>
                          <option value="true">활성</option>
                          <option value="false">비활성</option>
                        </select>
                      </label>
                    </div>

                    {flagError && (
                      <div className="rounded-lg border border-status-danger/20 bg-status-danger/10 px-4 py-3 text-sm text-status-danger">
                        {flagError}
                      </div>
                    )}

                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left">
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">라운드</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">팀</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">슬롯</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">플래그 값</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">상태</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">심은 시각</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">만료 시각</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {isFlagsLoading && (
                            <tr>
                              <td colSpan={7} className="px-4 py-12 text-center text-sm text-text-muted">
                                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                                플래그 목록을 불러오는 중...
                              </td>
                            </tr>
                          )}
                          {!isFlagsLoading && flagItems.length === 0 && (
                            <tr>
                              <td colSpan={7} className="px-4 py-12 text-center text-sm text-text-muted">
                                이 문제에 연결된 플래그가 없습니다.
                              </td>
                            </tr>
                          )}
                          {!isFlagsLoading &&
                            flagItems.map((flag) => (
                              <tr key={flag.id} className="hover:bg-bg-tertiary transition-colors">
                                <td className="px-4 py-3 font-mono text-xs text-text-primary">#{flag.round_number}</td>
                                <td className="px-4 py-3 text-xs text-text-primary">{flag.team_name}</td>
                                <td className="px-4 py-3">
                                  <div className="text-xs text-text-primary">{flag.slot_label}</div>
                                  <div className="font-mono text-[11px] text-text-muted">
                                    {flag.flag_filename} · {flag.point_value}점
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  <code className="font-mono text-xs text-accent bg-accent/10 px-1.5 py-0.5 rounded break-all">
                                    {flag.flag_value}
                                  </code>
                                </td>
                                <td className="px-4 py-3">
                                  <span
                                    className={cn(
                                      "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
                                      flag.is_active
                                        ? "bg-status-ok/10 text-status-ok"
                                        : "bg-bg-tertiary text-text-muted",
                                    )}
                                  >
                                    {flag.is_active ? "활성" : "비활성"}
                                  </span>
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

                    {flagTotalPages > 1 && (
                      <div className="flex items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={() => setFlagPage((prev) => Math.max(1, prev - 1))}
                          disabled={flagPage <= 1}
                          className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary disabled:opacity-40"
                        >
                          이전
                        </button>
                        <span className="text-xs text-text-muted font-mono">
                          {flagPage} / {flagTotalPages}
                        </span>
                        <button
                          type="button"
                          onClick={() => setFlagPage((prev) => Math.min(flagTotalPages, prev + 1))}
                          disabled={flagPage >= flagTotalPages}
                          className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary disabled:opacity-40"
                        >
                          다음
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {activeFlagTab === "submissions" && (
                  <div className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <label className="block">
                        <span className="text-xs text-text-muted mb-1 block">제출팀</span>
                        <input
                          type="text"
                          value={submissionSubmitterFilter}
                          onChange={(e) => {
                            setSubmissionSubmitterFilter(e.target.value);
                            setSubmissionPage(1);
                          }}
                          className="form-input"
                          placeholder="제출팀명"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-text-muted mb-1 block">피해팀</span>
                        <input
                          type="text"
                          value={submissionTargetFilter}
                          onChange={(e) => {
                            setSubmissionTargetFilter(e.target.value);
                            setSubmissionPage(1);
                          }}
                          className="form-input"
                          placeholder="피해팀명"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-text-muted mb-1 block">판정</span>
                        <select
                          value={submissionVerdictFilter}
                          onChange={(e) => {
                            setSubmissionVerdictFilter(e.target.value);
                            setSubmissionPage(1);
                          }}
                          className="form-input"
                        >
                          <option value="">전체</option>
                          {Object.entries(FLAG_VERDICT_MAP).map(([key, info]) => (
                            <option key={key} value={key}>
                              {info.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs text-text-muted mb-1 block">라운드</span>
                        <input
                          type="number"
                          value={submissionRoundFilter}
                          onChange={(e) => {
                            setSubmissionRoundFilter(e.target.value);
                            setSubmissionPage(1);
                          }}
                          className="form-input"
                          placeholder="라운드 번호"
                        />
                      </label>
                    </div>

                    {submissionError && (
                      <div className="rounded-lg border border-status-danger/20 bg-status-danger/10 px-4 py-3 text-sm text-status-danger">
                        {submissionError}
                      </div>
                    )}

                    <div className="overflow-x-auto rounded-xl border border-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left">
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">라운드</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">제출팀</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">피해팀</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">슬롯</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">제출 플래그</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">판정</th>
                            <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">제출 시각</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {isSubmissionsLoading && (
                            <tr>
                              <td colSpan={7} className="px-4 py-12 text-center text-sm text-text-muted">
                                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                                제출 기록을 불러오는 중...
                              </td>
                            </tr>
                          )}
                          {!isSubmissionsLoading && submissionItems.length === 0 && (
                            <tr>
                              <td colSpan={7} className="px-4 py-12 text-center text-sm text-text-muted">
                                이 문제의 제출 기록이 없습니다.
                              </td>
                            </tr>
                          )}
                          {!isSubmissionsLoading &&
                            submissionItems.map((item) => {
                              const verdictInfo = getVerdictInfo(item.verdict);
                              return (
                                <tr key={item.id} className="hover:bg-bg-tertiary transition-colors">
                                  <td className="px-4 py-3 font-mono text-xs text-text-primary">
                                    {item.round_number != null ? `#${item.round_number}` : "-"}
                                  </td>
                                  <td className="px-4 py-3 text-xs text-text-primary">{item.submitter_team_name}</td>
                                  <td className="px-4 py-3 text-xs text-text-secondary">{item.target_team_name ?? "-"}</td>
                                  <td className="px-4 py-3">
                                    <div className="text-xs text-text-primary">{item.slot_label ?? "-"}</div>
                                    <div className="font-mono text-[11px] text-text-muted">
                                      {item.slot_key ?? "-"}{item.points_awarded ? ` · ${item.points_awarded}점` : ""}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <code className="font-mono text-xs text-text-secondary bg-bg-tertiary px-1.5 py-0.5 rounded break-all">
                                      {item.submitted_flag}
                                    </code>
                                  </td>
                                  <td className="px-4 py-3">
                                    <span
                                      className={cn(
                                        "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
                                        STATUS_COLORS[verdictInfo.color],
                                        STATUS_BADGE_BG[verdictInfo.color],
                                      )}
                                    >
                                      {verdictInfo.label}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-xs text-text-muted font-mono">
                                    {formatDateTime(item.submitted_at)}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>

                    {submissionTotalPages > 1 && (
                      <div className="flex items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={() => setSubmissionPage((prev) => Math.max(1, prev - 1))}
                          disabled={submissionPage <= 1}
                          className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary disabled:opacity-40"
                        >
                          이전
                        </button>
                        <span className="text-xs text-text-muted font-mono">
                          {submissionPage} / {submissionTotalPages}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSubmissionPage((prev) => Math.min(submissionTotalPages, prev + 1))}
                          disabled={submissionPage >= submissionTotalPages}
                          className="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary disabled:opacity-40"
                        >
                          다음
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {activeFlagTab === "stats" && (
                  <div className="space-y-4">
                    {isFlagStatsLoading ? (
                      <div className="rounded-xl border border-border px-4 py-12 text-center text-sm text-text-muted">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                        서비스 통계를 불러오는 중...
                      </div>
                    ) : flagStatsError ? (
                      <div className="rounded-lg border border-status-danger/20 bg-status-danger/10 px-4 py-3 text-sm text-status-danger">
                        {flagStatsError}
                      </div>
                    ) : (
                      <>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                          <SummaryCard title="전체 플래그" value={flagStats?.total_flags_generated ?? 0} />
                          <SummaryCard title="전체 제출" value={flagStats?.total_submissions ?? 0} />
                          <SummaryCard
                            title="정답률"
                            value={`${(flagStats?.accuracy_rate ?? 0).toFixed(1)}%`}
                          />
                          <SummaryCard
                            title="라운드당 탈취율"
                            value={currentServiceStats ? currentServiceStats.capture_rate_per_round.toFixed(2) : "0.00"}
                          />
                        </div>

                        <div className="rounded-xl border border-border bg-bg-tertiary p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm font-medium text-text-primary">판정 분포</h3>
                            <span className="text-xs text-text-muted">
                              서비스 기준
                            </span>
                          </div>
                          <div className="space-y-2">
                            {Object.keys(flagStats?.submissions_by_verdict ?? {}).length === 0 && (
                              <p className="text-sm text-text-muted">데이터가 없습니다.</p>
                            )}
                            {Object.entries(flagStats?.submissions_by_verdict ?? {}).map(([key, count]) => {
                              const verdictInfo = getVerdictInfo(key);
                              const total = flagStats?.total_submissions || 1;
                              const ratio = ((count / total) * 100).toFixed(1);
                              return (
                                <div key={key} className="flex items-center justify-between text-sm">
                                  <span
                                    className={cn(
                                      "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
                                      STATUS_COLORS[verdictInfo.color],
                                      STATUS_BADGE_BG[verdictInfo.color],
                                    )}
                                  >
                                    {verdictInfo.label}
                                  </span>
                                  <span className="font-mono text-text-primary">
                                    {count.toLocaleString()} <span className="text-text-muted">({ratio}%)</span>
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        <div className="grid gap-4 xl:grid-cols-2">
                          <StatsTable
                            title="팀 공격 순위"
                            emptyMessage="공격 데이터가 없습니다."
                            headers={["팀", "전체 제출", "정답 수", "정확도", "공격 팀 수"]}
                            rows={(flagStats?.team_attack_stats ?? []).map((team) => [
                              team.team_name,
                              team.total_submissions.toLocaleString(),
                              team.correct_submissions.toLocaleString(),
                              `${team.accuracy_rate.toFixed(1)}%`,
                              String(team.unique_teams_attacked),
                            ])}
                          />
                          <StatsTable
                            title="팀 방어 순위"
                            emptyMessage="방어 데이터가 없습니다."
                            headers={["팀", "도난 플래그", "전체 플래그", "방어율"]}
                            rows={(flagStats?.team_defense_stats ?? []).map((team) => [
                              team.team_name,
                              team.flags_stolen.toLocaleString(),
                              team.flags_total.toLocaleString(),
                              `${team.defense_rate.toFixed(1)}%`,
                            ])}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            </section>
          )}

          {activeDetailTab === "build" && (
            <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-base font-semibold text-text-primary">빌드 상태</h2>
            {service.env_type === "dockerfile" ? (
              <div className="space-y-3">
                <div>
                  {service.build_status ? (
                    <span
                      className={cn(
                        "inline-flex px-2 py-0.5 rounded text-xs font-medium",
                        service.build_status === "success" && "bg-status-ok/10 text-status-ok",
                        service.build_status === "building" && "bg-status-info/10 text-status-info",
                        service.build_status === "failed" && "bg-status-danger/10 text-status-danger",
                      )}
                    >
                      {service.build_status === "success"
                        ? "빌드 성공"
                        : service.build_status === "building"
                        ? "빌드 중"
                        : "빌드 실패"}
                    </span>
                  ) : (
                    <span className="text-sm text-text-muted">빌드 전</span>
                  )}
                </div>
                <DetailRow label="환경 타입" value={service.env_type} />
                <DetailRow label="컨테이너 포트" value={String(service.container_port ?? "-")} />
                <DetailRow label="점수" value={String(service.score)} />
              </div>
            ) : service.env_type === "connection_info" ? (
              <div className="space-y-3">
                <DetailRow label="환경 타입" value={ENV_TYPE_LABELS[service.env_type]} />
                <DetailRow label="점수" value={String(service.score)} />
                <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-3 text-sm text-text-muted">
                  이 문제는 컨테이너 빌드 없이 접속 정보만 제공하는 수동 문제입니다.
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <DetailRow label="환경 타입" value={ENV_TYPE_LABELS[service.env_type]} />
                <DetailRow label="컨테이너 포트" value={String(service.container_port ?? "-")} />
                <DetailRow label="점수" value={String(service.score)} />
              </div>
            )}
            </section>
          )}
        </div>

        <div className="space-y-6 xl:sticky xl:top-24 self-start">
          <section className="rounded-xl border border-border bg-bg-secondary p-5 space-y-3">
            <h2 className="text-base font-semibold text-text-primary">작업</h2>

            {service.status === "draft" && (
              <>
                  <button
                    type="button"
                    onClick={() => openEdit(service, "service")}
                    disabled={actionLoading !== null}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
                  >
                  <Pencil className="w-4 h-4" />
                  문제 수정
                </button>
                {service.env_type === "image" && (
                  <button
                    type="button"
                    onClick={handleActivate}
                    disabled={actionLoading !== null}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-ok/15 text-status-ok hover:bg-status-ok/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "activate" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                    검증 후 활성화
                  </button>
                )}
                {service.env_type === "connection_info" && (
                  <button
                    type="button"
                    onClick={handleActivate}
                    disabled={actionLoading !== null}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-ok/15 text-status-ok hover:bg-status-ok/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "activate" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                    바로 활성화
                  </button>
                )}
                {service.env_type === "dockerfile" && service.build_status === "building" && (
                  <button
                    type="button"
                    disabled
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-info/15 text-status-info disabled:opacity-60"
                  >
                    <Loader2 className="w-4 h-4 animate-spin" />
                    빌드 진행 중
                  </button>
                )}
                {service.env_type === "dockerfile" && service.build_status !== "building" && (
                  <button
                    type="button"
                    onClick={handleBuild}
                    disabled={actionLoading !== null}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-ok/15 text-status-ok hover:bg-status-ok/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "build" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : service.build_status === "failed" ? (
                      <RotateCw className="w-4 h-4" />
                    ) : (
                      <Hammer className="w-4 h-4" />
                    )}
                    {service.build_status === "failed"
                      ? "빌드 재시도"
                      : service.build_status === "success"
                      ? "재빌드"
                      : "빌드 시작"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={actionLoading !== null}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-danger/15 text-status-danger hover:bg-status-danger/25 transition-colors disabled:opacity-50"
                >
                  {actionLoading === "delete" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  문제 삭제
                </button>
              </>
            )}

            {service.status === "active" && (
              <>
                {service.env_type !== "connection_info" && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={handleDeploy}
                      disabled={actionLoading !== null || !service.competition_id}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-info/15 text-status-info hover:bg-status-info/25 transition-colors disabled:opacity-50"
                    >
                      {actionLoading === "deploy" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Rocket className="w-4 h-4" />
                      )}
                      배포 시작
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleDeployOpen(true)}
                      disabled={actionLoading !== null || !service.competition_id}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-warning/15 text-status-warning hover:bg-status-warning/25 transition-colors disabled:opacity-50"
                    >
                      {actionLoading === "schedule-deploy" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Rocket className="w-4 h-4" />
                      )}
                      배포 예약
                    </button>
                  </div>
                )}
                {service.env_type === "dockerfile" && (
                  <button
                    type="button"
                    onClick={handleBuild}
                    disabled={actionLoading !== null}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "build" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RotateCw className="w-4 h-4" />
                    )}
                    재빌드
                  </button>
                )}
                {service.env_type === "connection_info" && (
                  <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
                    이 문제는 접속 정보만 제공하는 수동 문제라 배포와 재빌드 작업이 없습니다.
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const ok = window.confirm(
                      `"${service.name}" 문제를 완전히 삭제합니다.\n\n다음이 함께 정리됩니다:\n- 모든 팀의 배포된 컨테이너\n- 할당된 호스트 포트\n- Dockerfile 모드 빌드 이미지\n- 관련 플래그/SLA/팀 서비스 레코드\n\n이 작업은 되돌릴 수 없습니다. 계속하시겠습니까?`,
                    );
                    if (ok) handleDelete();
                  }}
                  disabled={actionLoading !== null}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-danger/15 text-status-danger hover:bg-status-danger/25 transition-colors disabled:opacity-50"
                >
                  {actionLoading === "delete" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  문제 삭제
                </button>
              </>
            )}
          </section>
        </div>
      </div>

      <Dialog.Root open={editOpen} onOpenChange={setEditOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(960px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 bg-bg-elevated border border-border rounded-xl shadow-2xl focus:outline-none flex flex-col">
            <div className="p-6 pb-0 shrink-0">
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
                {editMode === "service"
                  ? service.status === "draft"
                    ? "문제 수정"
                    : "접속 정보 수정"
                  : editMode === "healthcheck"
                    ? "헬스체크 수정"
                    : "플래그 수정"}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-secondary">
                {editMode === "service"
                  ? service.status === "draft"
                    ? "문제 기본 메타데이터와 접속 정보를 수정합니다."
                    : "참가자에게 보여줄 접속 정보만 수정합니다."
                  : editMode === "healthcheck"
                    ? "헬스체크 엔드포인트와 시나리오 step을 입력칸으로 수정합니다."
                    : "플래그 파일명, 점수, 난이도를 슬롯별로 수정합니다."}
              </Dialog.Description>
            </div>

            {editForm && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleEditSubmit();
                }}
                className="flex flex-col flex-1 min-h-0"
              >
                <div className="px-6 pt-5 pb-4 space-y-4 overflow-y-auto flex-1">
                  {editMode === "service" && service.status === "draft" && (
                    <>
                      <FormField label="문제 이름" required>
                        <input
                          type="text"
                          className="form-input"
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        />
                      </FormField>

                      <FormField label="카테고리" required>
                        <select
                          className="form-input"
                          value={editForm.category}
                          onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                        >
                          {CATEGORY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </FormField>
                    </>
                  )}

                  {editMode === "service" && service.env_type === "connection_info" && (
                    <FormField label="접속 정보">
                      <textarea
                        className="form-input resize-none"
                        rows={4}
                        value={editForm.connection_info}
                        onChange={(e) => setEditForm({ ...editForm, connection_info: e.target.value })}
                        placeholder={"예: http://10.1.x.10/\n예: nc TEAM_IP 31337\n예: guest / guest1234"}
                      />
                      <p className="mt-1 text-xs text-text-muted">
                        참가자에게 전달할 접속 방법을 적습니다. active 상태에서도 이 항목은 수정할 수 있습니다.
                      </p>
                    </FormField>
                  )}

                  {editMode === "service" && service.status === "draft" && service.env_type !== "connection_info" && (
                    <>
                      <FormField label="Docker 이미지">
                        <input
                          type="text"
                          className="form-input font-mono text-xs"
                          value={editForm.docker_image}
                          onChange={(e) => setEditForm({ ...editForm, docker_image: e.target.value })}
                          placeholder="예: registry.cstrike.io/vuln-web-sqli:latest"
                        />
                      </FormField>

                    </>
                  )}

                  {editMode === "service" && service.status === "draft" && (
                    <FormField label="설명">
                      <textarea
                        className="form-input resize-none"
                        rows={3}
                        value={editForm.description}
                        onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      />
                    </FormField>
                  )}

                  {editMode === "healthcheck" && (
                    <>
                      <FormField label="헬스체크 엔드포인트">
                        <input
                          type="text"
                          className="form-input font-mono text-xs"
                          value={editForm.health_check_endpoint}
                          onChange={(e) =>
                            setEditForm({ ...editForm, health_check_endpoint: e.target.value })
                          }
                          placeholder="예: /healthz (비우면 TCP 체크)"
                        />
                      </FormField>

                      <HealthCheckScenarioEditor
                        value={editForm.healthcheck_scenarios}
                        onChange={(healthcheck_scenarios) =>
                          setEditForm({ ...editForm, healthcheck_scenarios })
                        }
                        disabled={isEditSubmitting}
                      />
                    </>
                  )}

                  {editMode === "flags" && (
                    <>
                      <FormField label="총점">
                        <div className="form-input flex items-center justify-between">
                          <span>{editTotalPoints}점</span>
                          <span className="text-xs text-text-muted">슬롯별 점수 합계</span>
                        </div>
                      </FormField>

                      <FlagSlotEditor
                        slots={editForm.flag_slots}
                        onChange={(slots) => setEditForm({ ...editForm, flag_slots: slots })}
                        disabled={isEditSubmitting}
                      />
                    </>
                  )}
                </div>

                <div className="shrink-0 flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors"
                    >
                      취소
                    </button>
                  </Dialog.Close>
                  <button
                    type="submit"
                    disabled={isEditSubmitting || (editMode === "service" && !editForm.name.trim())}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent/80 text-white transition-colors disabled:opacity-50"
                  >
                    {isEditSubmitting ? "저장 중..." : "저장"}
                  </button>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={scheduleDeployOpen} onOpenChange={setScheduleDeployOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-elevated shadow-2xl focus:outline-none">
            <div className="border-b border-border px-6 py-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Dialog.Title className="text-lg font-semibold text-text-primary">
                    배포 예약
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-text-secondary">
                    원하는 시각을 지정하면 운영포털이 해당 시각에 자동으로 배포를 시작합니다.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md p-1 text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
                    aria-label="닫기"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </div>
            </div>

            <div className="space-y-4 px-6 py-5">
              <label className="block space-y-2">
                <span className="text-sm font-medium text-text-primary">예약 시각</span>
                <input
                  type="datetime-local"
                  value={scheduledForInput}
                  onChange={(e) => setScheduledForInput(e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                />
              </label>
              <p className="text-xs text-text-muted">
                예약 시각이 되면 승인된 팀 전체를 대상으로 현재 문제 이미지를 배포합니다.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  취소
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={handleScheduleDeploy}
                disabled={actionLoading !== null || !service?.competition_id}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-status-warning/15 px-4 py-2 text-sm font-medium text-status-warning hover:bg-status-warning/25 disabled:opacity-50"
              >
                {actionLoading === "schedule-deploy" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Rocket className="h-4 w-4" />
                )}
                예약 저장
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <style jsx global>{`
        .form-input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          line-height: 1.25rem;
          background-color: var(--color-bg-tertiary);
          border: 1px solid var(--color-border);
          border-radius: 0.5rem;
          color: var(--color-text-primary);
          transition: border-color 0.15s;
        }
        .form-input::placeholder {
          color: var(--color-text-muted);
        }
        .form-input:focus {
          outline: none;
          border-color: var(--color-accent);
          box-shadow: 0 0 0 1px var(--color-accent);
        }
        .form-input option {
          background-color: var(--color-bg-elevated);
          color: var(--color-text-primary);
        }
      `}</style>

      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2 w-96">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cn(
                "flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-lg border text-sm backdrop-blur-sm",
                toast.type === "success" && "bg-bg-elevated border-status-ok/30 text-status-ok",
                toast.type === "error" && "bg-bg-elevated border-status-danger/30 text-status-danger",
                toast.type === "building" && "bg-bg-elevated border-status-info/30 text-status-info",
              )}
            >
              {toast.type === "building" && <Loader2 className="w-4 h-4 animate-spin shrink-0 mt-0.5" />}
              {toast.type === "success" && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
              {toast.type === "error" && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span className="flex-1 text-text-primary">{toast.message}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
                className="p-0.5 text-text-muted hover:text-text-primary shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between items-baseline gap-4">
      <span className="text-text-muted text-xs uppercase tracking-wider shrink-0">
        {label}
      </span>
      <span
        className={cn(
          "text-text-primary text-right break-all",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SummaryCard({
  title,
  value,
}: {
  title: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-tertiary p-4">
      <p className="text-xs text-text-muted uppercase tracking-wider">{title}</p>
      <p className="mt-2 text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function StatsTable({
  title,
  headers,
  rows,
  emptyMessage,
}: {
  title: string;
  headers: string[];
  rows: string[][];
  emptyMessage: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-tertiary overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              {headers.map((header) => (
                <th
                  key={header}
                  className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={headers.length}
                  className="px-4 py-12 text-center text-sm text-text-muted"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={`${title}-${index}`} className="hover:bg-bg-secondary transition-colors">
                  {row.map((cell, cellIndex) => (
                    <td key={`${title}-${index}-${cellIndex}`} className="px-4 py-3 text-xs text-text-secondary">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FormField({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-text-secondary">
        {label}
        {required && <span className="text-status-danger ml-0.5">*</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
