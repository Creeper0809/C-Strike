"use client";

import { useCallback, useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, X, Trash2, Loader2, Pencil, CheckCircle2, Hammer, RotateCw, AlertTriangle, Rocket, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { DEPLOY_STAGES, DEPLOY_STAGE_LABELS, SERVICE_STATUS_MAP, STATUS_COLORS } from "@/lib/constants";
import type { DeployPipeline, FlagSlotConfig, VulnService } from "@/types/ops";
import PageHeader from "@/components/ui/PageHeader";
import DataTable from "@/components/ui/DataTable";
import FlagSlotEditor, { createDefaultFlagSlot } from "@/components/services/FlagSlotEditor";
import HealthCheckScenarioEditor from "@/components/services/HealthCheckScenarioEditor";
import {
  extractHealthcheckScenarioDocument,
  type HealthcheckScenarioDocument,
} from "@/components/services/healthcheckScenarioUtils";

/* ─── 상수 ────────────────────────────────────────────── */

const STATUS_FILTER_TABS = [
  { value: "all", label: "전체" },
  { value: "draft", label: "초안" },
  { value: "active", label: "활성" },
] as const;

const CATEGORY_OPTIONS = [
  { value: "web", label: "웹" },
  { value: "pwn", label: "포너블" },
  { value: "crypto", label: "암호학" },
  { value: "reversing", label: "리버싱" },
  { value: "misc", label: "기타" },
] as const;

const PAGE_SIZE = 20;
type ServiceEnvironmentType = "dockerfile" | "image" | "connection_info";

const ENV_TYPE_LABELS: Record<ServiceEnvironmentType, string> = {
  image: "Docker 이미지",
  dockerfile: "Dockerfile 업로드",
  connection_info: "접속 정보",
};

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
  created_at: string | null;
}

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

/* ─── 상태 뱃지 컴포넌트 ──────────────────────────────── */

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
  const colorClass = STATUS_COLORS[mapped.color];
  const bgClass = STATUS_BADGE_BG[mapped.color];

  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
        colorClass,
        bgClass,
      )}
    >
      {mapped.label}
    </span>
  );
}

/* ─── 날짜 포맷 ───────────────────────────────────────── */

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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

/* ─── 테이블 컬럼 정의 ────────────────────────────────── */

const SERVICE_COLUMNS = [
  { key: "name", label: "이름", sortable: true },
  { key: "category", label: "카테고리", sortable: true },
  {
    key: "docker_image",
    label: "Docker 이미지",
    className: "font-mono text-xs",
  },
  {
    key: "status",
    label: "상태",
    render: (row: VulnService) => <StatusBadge status={row.status} />,
  },
  {
    key: "created_at",
    label: "등록일",
    sortable: true,
    render: (row: VulnService) => formatDate(row.created_at),
  },
];

/* ─── 등록 폼 초기값 ──────────────────────────────────── */

interface RegisterFormData {
  name: string;
  category: string;
  competition_id: string;
  docker_image: string;
  description: string;
  connection_info: string;
  flag_slots: FlagSlotConfig[];
  health_check_endpoint: string;
  healthcheck_scenarios: HealthcheckScenarioDocument | null;
  env_type: ServiceEnvironmentType;
  container_port: string;
}

const INITIAL_FORM: RegisterFormData = {
  name: "",
  category: "web",
  competition_id: "",
  docker_image: "",
  description: "",
  connection_info: "",
  flag_slots: [createDefaultFlagSlot(1, 100)],
  health_check_endpoint: "",
  healthcheck_scenarios: null,
  env_type: "image" as const,
  container_port: "",
};

interface CompetitionOption {
  id: string;
  name: string;
  status: string;
}

/* ─── 토스트 알림 타입 ────────────────────────────────── */

interface ToastItem {
  id: string;
  message: string;
  type: "building" | "success" | "error";
}

/* ─── 메인 페이지 ─────────────────────────────────────── */

export default function ServicesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialStatus =
    STATUS_FILTER_TABS.some((tab) => tab.value === searchParams.get("status"))
      ? searchParams.get("status") ?? "all"
      : "all";
  const initialPage = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  /* 서비스 목록 */
  const [services, setServices] = useState<VulnService[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [isLoading, setIsLoading] = useState(true);

  /* 상세 패널 */
  const [selected, setSelected] = useState<VulnService | null>(null);

  /* 등록 모달 */
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<RegisterFormData>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* 대회 목록 (등록/대회 연결 드롭다운 공용) */
  const [competitions, setCompetitions] = useState<CompetitionOption[]>([]);
  const [isLinkingCompetition, setIsLinkingCompetition] = useState(false);

  /* 빌드 파일 */
  const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".DS_Store"]);
  const MAX_UPLOAD_FILES = 500;
  const [buildFiles, setBuildFiles] = useState<File[]>([]);
  const [uploadMode, setUploadMode] = useState<"files" | "folder" | "zip">("files");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  /* 토스트 알림 */
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const registerTotalPoints = form.flag_slots.reduce((sum, slot) => sum + (Number(slot.points) || 0), 0);

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
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), type === "error" ? 10_000 : 5_000);
    }
    return toastId;
  }

  /* 액션 로딩 */
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /* 배포 이력/상세 */
  const [deployPipelines, setDeployPipelines] = useState<PipelineListItem[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [selectedPipeline, setSelectedPipeline] = useState<DeployPipeline | null>(null);
  const [selectedDeployStage, setSelectedDeployStage] = useState<string | null>(null);
  const [isDeployLoading, setIsDeployLoading] = useState(false);
  const [showDeployHistory, setShowDeployHistory] = useState(false);

  /* 편집 모달 */
  const [editOpen, setEditOpen] = useState(false);
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

  /* ── 데이터 페칭 ─────────────────────────────────────── */

  const fetchServices = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (statusFilter !== "all") {
        params.set("status_filter", statusFilter);
      }

      const res = await apiFetch<{ items: VulnService[]; total: number }>(
        `/services/?${params.toString()}`,
      );
      setServices(res.items);
      setTotal(res.total);
    } catch {
      setServices([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  /* ── 대회 목록 로드 (상세 조회/등록 공용) ───────────── */
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

  useEffect(() => {
    fetchCompetitions();
  }, [fetchCompetitions]);

  useEffect(() => {
    const nextStatus =
      STATUS_FILTER_TABS.some((tab) => tab.value === searchParams.get("status"))
        ? searchParams.get("status") ?? "all"
        : "all";
    const nextPage = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
    setStatusFilter(nextStatus);
    setPage(nextPage);
  }, [searchParams]);

  function syncListQuery(nextPage: number, nextStatus: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextStatus === "all") {
      params.delete("status");
    } else {
      params.set("status", nextStatus);
    }

    if (nextPage <= 1) {
      params.delete("page");
    } else {
      params.set("page", String(nextPage));
    }

    const query = params.toString();
    router.replace(query ? `/services?${query}` : "/services");
  }

  /* ── 탭 전환 ─────────────────────────────────────────── */

  function handleTabChange(value: string) {
    setStatusFilter(value);
    setPage(1);
    setSelected(null);
    syncListQuery(1, value);
  }

  /* ── 등록 제출 ───────────────────────────────────────── */

  async function handleRegister() {
    if (!form.name.trim()) return;
    if (form.env_type === "image" && !form.docker_image.trim()) return;
    if (form.env_type === "connection_info" && !form.connection_info.trim()) return;
    if (!form.competition_id) {
      alert("문제를 등록할 대회를 선택해 주세요. 대회가 없으면 먼저 운영용 대회를 준비하세요.");
      return;
    }

    setIsSubmitting(true);
    const serviceName = form.name.trim();

    let created: VulnService | null = null;
    try {
      const body = {
        ...form,
        competition_id: form.competition_id || null,
        container_port:
          form.env_type === "connection_info"
            ? null
            : form.container_port
              ? parseInt(form.container_port)
              : null,
        docker_image: form.env_type === "image" ? form.docker_image : null,
        connection_info: form.connection_info.trim() || null,
        healthcheck_scenarios: form.healthcheck_scenarios,
      };
      created = await apiFetch<VulnService>("/services/", {
        method: "POST",
        body: JSON.stringify(body),
      });

      // 빌드 파일/ZIP 업로드
      let uploaded = false;
      if (created?.id && form.env_type === "dockerfile") {
        try {
          if (uploadMode === "zip" && zipFile) {
            const fd = new FormData();
            fd.append("file", zipFile);
            await apiFetch(`/services/${created.id}/build-archive?replace=true`, {
              method: "POST",
              body: fd,
            });
            uploaded = true;
          } else if (buildFiles.length > 0) {
            const fd = new FormData();
            for (const f of buildFiles) {
              const rp = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
              if (rp) {
                const parts = rp.split("/");
                const pathWithoutRoot = parts.length > 1 ? parts.slice(1).join("/") : rp;
                fd.append("files", f, pathWithoutRoot);
              } else {
                fd.append("files", f);
              }
            }
            await apiFetch(`/services/${created.id}/build-files`, {
              method: "POST",
              body: fd,
            });
            uploaded = true;
          }
        } catch (uploadError) {
          let rolledBack = false;
          try {
            await apiFetch(`/services/${created.id}`, { method: "DELETE" });
            rolledBack = true;
          } catch {
            rolledBack = false;
          }

          const reason =
            uploadError instanceof Error ? uploadError.message : "알 수 없는 오류";

          throw new Error(
            rolledBack
              ? `빌드 파일 업로드에 실패해 등록을 되돌렸습니다: ${reason}`
              : `빌드 파일 업로드에 실패했습니다. 서비스는 생성되었을 수 있습니다: ${reason}`,
          );
        }
      }

      // 즉시 폼 리셋 — 다음 서비스 등록 가능
      setForm(INITIAL_FORM);
      setBuildFiles([]);
      setZipFile(null);
      setUploadMode("files");
      fetchServices();

      if (uploaded) {
        // 빌드는 백그라운드 실행 — 토스트로 결과 알림
        const toastId = addToast(`"${serviceName}" 등록 완료 — 빌드 진행 중...`, "building");
        fireBuildInBackground(created.id, serviceName, toastId);
      } else {
        addToast(`"${serviceName}" 등록 완료`, "success");
      }
    } catch (err) {
      addToast(`"${serviceName}" 등록 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function fireBuildInBackground(serviceId: string, serviceName: string, toastId: string) {
    try {
      const result = await apiFetch<{ build_status: string; message: string }>(
        `/services/${serviceId}/build`,
        { method: "POST" },
      );
      if (result.build_status === "success") {
        addToast(`"${serviceName}" 빌드 성공 — 활성화됨`, "success", toastId);
      } else {
        addToast(`"${serviceName}" 빌드 실패: ${result.message || "알 수 없음"}`, "error", toastId);
      }
    } catch {
      const finalSvc = await pollBuildResult(serviceId);
      if (finalSvc?.build_status === "success") {
        addToast(`"${serviceName}" 빌드 성공 — 활성화됨`, "success", toastId);
      } else if (finalSvc?.build_status === "failed") {
        addToast(`"${serviceName}" 빌드 실패: ${finalSvc.build_log || "알 수 없음"}`, "error", toastId);
      } else {
        addToast(`"${serviceName}" 빌드 상태 확인 불가 — 목록에서 확인하세요`, "error", toastId);
      }
    }
    fetchServices();
  }

  /* ── 편집 모달 ───────────────────────────────────────── */

  function openEdit(svc: VulnService) {
    setEditForm({
      name: svc.name,
      description: svc.description ?? "",
      connection_info: svc.connection_info ?? "",
      category: svc.category,
      docker_image: svc.docker_image ?? "",
      flag_slots: svc.flag_slots?.length ? svc.flag_slots.map((slot) => ({ ...slot })) : [createDefaultFlagSlot(1, svc.score ?? 100)],
      health_check_endpoint: svc.health_check_endpoint ?? "",
      healthcheck_scenarios: extractHealthcheckScenarioDocument(svc.healthcheck_scenarios),
    });
    setEditOpen(true);
  }

  /* ── 대회 연결/변경 (active 상태에서도 허용) ────────── */
  async function handleLinkCompetition(
    serviceId: string,
    competitionId: string | null,
  ) {
    setIsLinkingCompetition(true);
    try {
      const updated = await apiFetch<VulnService>(`/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ competition_id: competitionId }),
      });
      setSelected(updated);
      await fetchServices();
    } catch (err) {
      alert(
        `대회 연결 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
      );
    } finally {
      setIsLinkingCompetition(false);
    }
  }

  async function handleEditSubmit() {
    if (!selected || !editForm) return;
    setIsEditSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: editForm.name.trim(),
        category: editForm.category,
        description: editForm.description.trim() || null,
        connection_info: editForm.connection_info.trim() || null,
        docker_image: editForm.docker_image.trim() || null,
        flag_slots: editForm.flag_slots,
        health_check_endpoint: editForm.health_check_endpoint.trim() || null,
        healthcheck_scenarios: editForm.healthcheck_scenarios,
      };
      const updated = await apiFetch<VulnService>(`/services/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setEditOpen(false);
      setEditForm(null);
      setSelected(updated);
      await fetchServices();
    } catch (err) {
      alert(`수정 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
    } finally {
      setIsEditSubmitting(false);
    }
  }

  async function handleActivate(id: string) {
    setActionLoading("activate");
    try {
      const updated = await apiFetch<VulnService>(`/services/${id}/activate`, {
        method: "POST",
      });
      setSelected(updated);
      await fetchServices();
    } catch (err) {
      alert(`활성화 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`);
    } finally {
      setActionLoading(null);
    }
  }

  // 빌드 상태 폴링: 504/network error로 동기 응답을 못 받아도
  // 백그라운드에서는 빌드가 계속 진행될 수 있으므로 DB 상태를 직접 확인한다.
  // 최대 10분까지 5초 간격 폴링. building 유지면 에러, success/failed면 결과 반영.
  async function pollBuildResult(id: string, maxSeconds = 600): Promise<VulnService | null> {
    const pollInterval = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxSeconds * 1000) {
      await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const svc = await apiFetch<VulnService>(`/services/${id}`);
        if (svc.build_status === "success" || svc.build_status === "failed") {
          return svc;
        }
      } catch {
        // 일시적 네트워크 오류는 무시하고 다음 틱 재시도
      }
    }
    return null;
  }

  async function handleBuild(id: string) {
    // Dockerfile 모드 빌드 시작/재시도. deploy-service가 빌드 완료까지 동기 대기 (최대 10분).
    // 응답을 못 받아도(504/abort/network) 폴링으로 최종 상태를 확인한다.
    setActionLoading("build");
    try {
      const result = await apiFetch<{ build_status: string; message: string }>(
        `/services/${id}/build`,
        { method: "POST" },
      );
      const refreshed = await apiFetch<VulnService>(`/services/${id}`);
      setSelected(refreshed);
      await fetchServices();
      if (result.build_status !== "success") {
        alert(`빌드 실패: ${result.message || "알 수 없음"}`);
      }
    } catch (err) {
      // 504/네트워크 오류 → 백그라운드 빌드 중일 수 있으므로 폴링으로 실제 상태 확인
      const finalSvc = await pollBuildResult(id);
      if (finalSvc) {
        setSelected(finalSvc);
        await fetchServices();
        if (finalSvc.build_status === "failed") {
          alert(`빌드 실패: ${finalSvc.build_log || "알 수 없음"}`);
        }
        // success면 조용히 갱신 — 사용자는 active 상태만 보면 됨
      } else {
        alert(
          `빌드 상태를 확인할 수 없습니다. 잠시 후 새로고침하여 상세 패널에서 확인해주세요.\n${
            err instanceof Error ? err.message : "알 수 없는 오류"
          }`,
        );
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDeploy(id: string, serviceName: string) {
    setActionLoading("deploy");
    try {
      await apiFetch("/deploy/pipelines", {
        method: "POST",
        body: JSON.stringify({ service_id: id }),
      });
      addToast(`"${serviceName}" 배포를 시작했습니다.`, "success");
      await fetchDeployPipelines(id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "알 수 없는 오류";
      addToast(`"${serviceName}" 배포 실패: ${message}`, "error");
    } finally {
      setActionLoading(null);
    }
  }

  /* ── 서비스 액션 (삭제) ──────────────────────────────── */

  async function handleDelete(id: string) {
    setActionLoading("delete");
    try {
      await apiFetch(`/services/${id}`, { method: "DELETE" });
      setSelected(null);
      await fetchServices();
    } finally {
      setActionLoading(null);
    }
  }

  const fetchDeployPipelines = useCallback(async (serviceId: string) => {
    setIsDeployLoading(true);
    try {
      const data = await apiFetch<{ items: PipelineListItem[]; total: number }>(
        `/deploy/pipelines?service_id=${serviceId}&page=1&limit=5`,
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

  useEffect(() => {
    if (!selected?.id) {
      setDeployPipelines([]);
      setSelectedPipelineId(null);
      setSelectedPipeline(null);
      setSelectedDeployStage(null);
      setShowDeployHistory(false);
      return;
    }
    setShowDeployHistory(false);
    fetchDeployPipelines(selected.id);
  }, [selected?.id, fetchDeployPipelines]);

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

  /* ── 페이지네이션 ────────────────────────────────────── */

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canPrev = page > 1;
  const canNext = page < totalPages;
  const selectedDeployStageDetail =
    selectedPipeline && selectedDeployStage
      ? selectedPipeline.stages.find((stage) => stage.stage_name === selectedDeployStage) ?? null
      : null;
  const latestPipeline = deployPipelines[0] ?? null;
  const historyPipelines = latestPipeline
    ? deployPipelines.filter((pipeline) => pipeline.id !== latestPipeline.id)
    : [];

  /* ── 렌더링 ──────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <PageHeader
        title="문제 관리"
        description={`총 ${total}개 문제 | 문제 하나에 여러 취약점을 포함할 수 있습니다.`}
        actions={
          <button
            type="button"
            onClick={() => setRegisterOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent/80 text-white transition-colors"
          >
            <Plus className="w-4 h-4" />
            등록
          </button>
        }
      />

      {/* 상태 필터 탭 */}
      <Tabs.Root value={statusFilter} onValueChange={handleTabChange}>
        <Tabs.List className="flex gap-1 border-b border-border">
          {STATUS_FILTER_TABS.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
                "text-text-secondary hover:text-text-primary",
                "data-[state=active]:text-accent data-[state=active]:border-accent",
                "data-[state=inactive]:border-transparent",
              )}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      {/* 테이블 + 상세 패널 레이아웃 */}
      <div className="flex gap-6">
        {/* 테이블 영역 */}
        <div className={cn("transition-all", selected ? "flex-1 min-w-0" : "w-full")}>
          <DataTable
            columns={SERVICE_COLUMNS}
            data={services}
            keyExtractor={(row) => row.id}
            onRowClick={(row) => {
              const query = searchParams.toString();
              router.push(`/services/${row.id}${query ? `?${query}` : ""}`);
            }}
            isLoading={isLoading}
            emptyMessage="등록된 문제가 없습니다"
          />

          {/* 페이지네이션 */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                disabled={!canPrev}
                onClick={() => {
                  const nextPage = page - 1;
                  setPage(nextPage);
                  syncListQuery(nextPage, statusFilter);
                }}
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
                onClick={() => {
                  const nextPage = page + 1;
                  setPage(nextPage);
                  syncListQuery(nextPage, statusFilter);
                }}
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

        {/* 상세 패널 */}
        {selected && (
          <div className="w-96 shrink-0 bg-bg-secondary border border-border rounded-xl p-5 space-y-5 self-start">
            {/* 패널 헤더 */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-semibold text-text-primary">
                  {selected.name}
                </h2>
                <StatusBadge status={selected.status} />
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                aria-label="패널 닫기"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 상세 정보 */}
            <div className="space-y-3 text-sm">
              <DetailRow label="카테고리" value={selected.category} />
              <DetailRow label="환경 타입" value={ENV_TYPE_LABELS[selected.env_type]} />
              {selected.env_type !== "connection_info" && (
                <DetailRow label="Docker 이미지" value={selected.docker_image ?? "-"} mono />
              )}
              <DetailRow label="버전" value={`v${selected.version}`} />
              <DetailRow label="등록자" value={selected.registered_by_name ?? selected.registered_by} />
              <DetailRow label="등록일" value={formatDate(selected.created_at)} />
              {selected.connection_info && (
                <div>
                  <span className="text-text-muted text-xs uppercase tracking-wider">
                    접속 정보
                  </span>
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
                    {selected.connection_info}
                  </pre>
                </div>
              )}

              {/* 귀속 대회 — 인라인 변경 가능 (active 상태에서도) */}
              <div className="py-2 border-t border-border/50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-text-muted text-xs uppercase tracking-wider">
                    귀속 대회
                  </span>
                  {!selected.competition_id && (
                    <span className="text-xs text-status-warning">
                      미지정 · 배포 불가
                    </span>
                  )}
                </div>
                {competitions.length === 0 ? (
                  <div className="text-xs text-text-muted py-1">
                    등록된 대회가 없습니다. 먼저 운영용 대회를 준비하세요.
                  </div>
                ) : (
                  <select
                    value={selected.competition_id ?? ""}
                    disabled={isLinkingCompetition}
                    onChange={(e) =>
                      handleLinkCompetition(selected.id, e.target.value || null)
                    }
                    className="form-input text-sm"
                  >
                    <option value="">미지정</option>
                    {competitions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.status})
                      </option>
                    ))}
                  </select>
                )}
                {isLinkingCompetition && (
                  <p className="text-xs text-text-muted mt-1">대회 연결 중...</p>
                )}
              </div>

              <DetailRow
                label="헬스체크 경로"
                value={selected.health_check_endpoint ?? "TCP 체크"}
                mono={!!selected.health_check_endpoint}
              />
              {selected.approved_by && (
                <DetailRow label="승인자" value={selected.approved_by_name ?? selected.approved_by} />
              )}
              {selected.approved_at && (
                <DetailRow label="승인일" value={formatDate(selected.approved_at)} />
              )}
              {selected.description && (
                <div>
                  <span className="text-text-muted text-xs uppercase tracking-wider">
                    설명
                  </span>
                  <p className="mt-1 text-text-secondary leading-relaxed">
                    {selected.description}
                  </p>
                </div>
              )}
              {selected && selected.env_type === "dockerfile" && (
                <div className="mt-3 space-y-1">
                  <span className="text-xs text-tertiary">빌드 상태</span>
                  <div>
                    {selected.build_status ? (
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        selected.build_status === "success" ? "bg-status-ok/10 text-status-ok" :
                        selected.build_status === "building" ? "bg-status-info/10 text-status-info" :
                        "bg-status-danger/10 text-status-danger"
                      }`}>
                        {selected.build_status === "success" ? "빌드 성공" :
                         selected.build_status === "building" ? "빌드 중" : "빌드 실패"}
                      </span>
                    ) : (
                      <span className="text-xs text-tertiary">빌드 전</span>
                    )}
                  </div>
                </div>
              )}

              <div className="py-2 border-t border-border/50 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted text-xs uppercase tracking-wider">
                    배포 현황
                  </span>
                  {selected.competition_id && (
                    <button
                      type="button"
                      onClick={() => fetchDeployPipelines(selected.id)}
                      disabled={isDeployLoading}
                      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={cn("w-3 h-3", isDeployLoading && "animate-spin")} />
                      새로고침
                    </button>
                  )}
                </div>

                {!selected.competition_id ? (
                  <p className="text-xs text-text-muted">
                    귀속 대회를 지정해야 배포 이력과 현재 상태를 확인할 수 있습니다.
                  </p>
                ) : isDeployLoading && deployPipelines.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    배포 이력을 불러오는 중...
                  </div>
                ) : deployPipelines.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    아직 배포 이력이 없습니다. 활성 문제라면 아래에서 바로 배포를 시작할 수 있습니다.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {latestPipeline && (
                      <div className="rounded-lg border border-border bg-bg-tertiary p-3 space-y-3">
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
                            <div className="space-y-1">
                              <DetailRow
                                label="현재 단계"
                                value={
                                  selectedPipeline.current_stage
                                    ? (DEPLOY_STAGE_LABELS[selectedPipeline.current_stage] ?? selectedPipeline.current_stage)
                                    : "-"
                                }
                              />
                              <DetailRow label="시작" value={formatDateTime(selectedPipeline.started_at)} />
                              <DetailRow label="완료" value={formatDateTime(selectedPipeline.completed_at)} />
                              <DetailRow
                                label="실행자"
                                value={selectedPipeline.triggered_by_name ?? selectedPipeline.triggered_by}
                              />
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
                                  <DeployStatusBadge
                                    status={selectedDeployStageDetail?.status ?? "pending"}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <DetailRow
                                    label="시작"
                                    value={formatDateTime(selectedDeployStageDetail?.started_at ?? null)}
                                  />
                                  <DetailRow
                                    label="완료"
                                    value={formatDateTime(selectedDeployStageDetail?.completed_at ?? null)}
                                  />
                                </div>
                                <pre className="max-h-48 overflow-auto rounded-lg bg-bg-primary px-3 py-2 text-[11px] text-text-secondary whitespace-pre-wrap break-words">
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
                            ? `이전 이력 숨기기`
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
                                  {pipeline.current_stage
                                    ? DEPLOY_STAGE_LABELS[pipeline.current_stage] ?? pipeline.current_stage
                                    : "단계 정보 없음"}
                                </div>
                                <div className="mt-0.5 text-[11px] text-text-muted font-mono">
                                  {formatDateTime(pipeline.started_at ?? pipeline.created_at)}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 액션 버튼 — draft 상태: 수정/(이미지 모드 활성화)/삭제 */}
            {selected.status === "draft" && (
              <div className="space-y-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => openEdit(selected)}
                  disabled={actionLoading !== null}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
                >
                  <Pencil className="w-4 h-4" />
                  문제 수정
                </button>
                {selected.env_type === "image" && (
                  <button
                    type="button"
                    onClick={() => handleActivate(selected.id)}
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
                {selected.env_type === "connection_info" && (
                  <button
                    type="button"
                    onClick={() => handleActivate(selected.id)}
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
                {selected.env_type === "dockerfile" && selected.build_status === "building" && (
                  <button
                    type="button"
                    disabled
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-info/15 text-status-info disabled:opacity-60"
                  >
                    <Loader2 className="w-4 h-4 animate-spin" />
                    빌드 진행 중
                  </button>
                )}
                {selected.env_type === "dockerfile" && selected.build_status !== "building" && (
                  <button
                    type="button"
                    onClick={() => handleBuild(selected.id)}
                    disabled={actionLoading !== null}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-ok/15 text-status-ok hover:bg-status-ok/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "build" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : selected.build_status === "failed" ? (
                      <RotateCw className="w-4 h-4" />
                    ) : (
                      <Hammer className="w-4 h-4" />
                    )}
                    {selected.build_status === "failed"
                      ? "빌드 재시도"
                      : selected.build_status === "success"
                      ? "재빌드"
                      : "빌드 시작"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(selected.id)}
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
              </div>
            )}

            {/* 액션 버튼 — active 상태: 재빌드/삭제 */}
            {selected.status === "active" && (
              <div className="space-y-2 pt-2 border-t border-border">
                {selected.env_type !== "connection_info" && (
                  <button
                    type="button"
                    onClick={() => handleDeploy(selected.id, selected.name)}
                    disabled={actionLoading !== null || !selected.competition_id}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-status-info/15 text-status-info hover:bg-status-info/25 transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "deploy" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Rocket className="w-4 h-4" />
                    )}
                    배포 시작
                  </button>
                )}
                {selected.env_type === "dockerfile" && (
                  <button
                    type="button"
                    onClick={() => handleBuild(selected.id)}
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
                {selected.env_type === "connection_info" && (
                  <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
                    이 문제는 접속 정보만 제공하는 수동 문제라 배포/재빌드 작업이 없습니다.
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const ok = window.confirm(
                      `"${selected.name}" 문제를 완전히 삭제합니다.\n\n다음이 함께 정리됩니다:\n- 모든 팀의 배포된 컨테이너 (정지/삭제)\n- 할당된 호스트 포트 해제\n- Dockerfile 모드 빌드 이미지 제거\n- 관련 플래그/SLA/팀 서비스 레코드\n\n이 작업은 되돌릴 수 없습니다. 계속하시겠습니까?`,
                    );
                    if (ok) handleDelete(selected.id);
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
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 등록 모달 ──────────────────────────────────── */}
      <Dialog.Root open={registerOpen} onOpenChange={(open) => {
        setRegisterOpen(open);
        if (!open) { setZipFile(null); setUploadMode("files"); }
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(960px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 bg-bg-elevated border border-border rounded-xl shadow-2xl focus:outline-none flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            {/* 헤더 (고정) */}
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
                문제 등록
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-secondary">
                하나의 문제 안에 여러 취약점을 포함할 수 있습니다. Dockerfile 모드는 빌드 성공 시 자동으로 활성화됩니다.
              </Dialog.Description>
            </div>

            {/* 폼 (스크롤 영역) */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRegister();
              }}
              className="flex flex-col flex-1 min-h-0"
            >
              <div className="px-6 pt-5 pb-4 space-y-4 overflow-y-auto flex-1">
              {/* 이름 */}
              <FormField label="문제 이름" required>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="예: vuln-web-sqli"
                  className="form-input"
                />
              </FormField>

              {/* 카테고리 */}
              <FormField label="카테고리" required>
                <select
                  value={form.category}
                  onChange={(e) =>
                    setForm({ ...form, category: e.target.value })
                  }
                  className="form-input"
                >
                  {CATEGORY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="총점">
                <div className="form-input flex items-center justify-between">
                  <span>{registerTotalPoints}점</span>
                  <span className="text-xs text-text-muted">슬롯별 점수 합계</span>
                </div>
              </FormField>

              {/* 귀속 대회 — 배포/롤백 전 필수 */}
              <FormField label="귀속 대회" required>
                {competitions.length === 0 ? (
                  <div className="form-input text-text-muted text-sm">
                    등록된 대회가 없습니다. 먼저 운영용 대회를 준비하세요.
                  </div>
                ) : (
                  <select
                    value={form.competition_id}
                    onChange={(e) =>
                      setForm({ ...form, competition_id: e.target.value })
                    }
                    className="form-input"
                  >
                    <option value="">대회를 선택하세요</option>
                    {competitions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.status})
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-text-muted mt-1">
                  이 문제가 어느 대회에서 운영되는지 지정합니다. 배포는 해당 대회의 승인된 팀에만 이뤄집니다.
                </p>
              </FormField>

              {/* 환경 타입 선택 */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-secondary">환경 타입</label>
                <div className="grid gap-2 md:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, env_type: "image" }))}
                    className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      form.env_type === "image"
                        ? "bg-accent text-white border-accent"
                        : "bg-card border-border text-secondary hover:bg-card-hover"
                    }`}
                  >
                    Docker 이미지
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, env_type: "dockerfile" }))}
                    className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      form.env_type === "dockerfile"
                        ? "bg-accent text-white border-accent"
                        : "bg-card border-border text-secondary hover:bg-card-hover"
                    }`}
                  >
                    Dockerfile 업로드
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, env_type: "connection_info" }))}
                    className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      form.env_type === "connection_info"
                        ? "bg-accent text-white border-accent"
                        : "bg-card border-border text-secondary hover:bg-card-hover"
                    }`}
                  >
                    접속 정보
                  </button>
                </div>
              </div>

              {/* Docker 이미지 */}
              {form.env_type === "image" && (
                <FormField label="Docker 이미지" required>
                  <input
                    type="text"
                    value={form.docker_image}
                    onChange={(e) =>
                      setForm({ ...form, docker_image: e.target.value })
                    }
                    placeholder="예: registry.cstrike.io/vuln-web-sqli:latest"
                    className="form-input font-mono text-xs"
                  />
                </FormField>
              )}

              {/* Dockerfile 업로드 */}
              {form.env_type === "dockerfile" && (
                <div className="space-y-3">
                  <label className="text-sm font-medium text-secondary">빌드 파일 업로드</label>

                  {/* 모드 선택 탭 */}
                  <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg">
                    <button
                      type="button"
                      onClick={() => setUploadMode("files")}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${uploadMode === "files" ? "bg-card text-primary shadow-sm" : "text-tertiary hover:text-secondary"}`}
                    >
                      개별 파일 선택
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploadMode("folder")}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${uploadMode === "folder" ? "bg-card text-primary shadow-sm" : "text-tertiary hover:text-secondary"}`}
                    >
                      폴더 업로드
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploadMode("zip")}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${uploadMode === "zip" ? "bg-card text-primary shadow-sm" : "text-tertiary hover:text-secondary"}`}
                    >
                      ZIP 업로드
                    </button>
                  </div>

                  {/* 개별 파일 모드 */}
                  {uploadMode === "files" && (
                    <>
                      <div
                        className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-accent transition-colors"
                        onClick={() => document.getElementById("build-file-input")?.click()}
                      >
                        <p className="text-secondary text-sm">클릭하여 파일 선택</p>
                        <p className="text-xs text-tertiary mt-1">Dockerfile + 소스 파일 (최대 200MB)</p>
                      </div>
                      <input
                        id="build-file-input"
                        type="file"
                        multiple
                        className="hidden"
                        onChange={e => {
                          if (e.target.files) {
                            setBuildFiles(Array.from(e.target.files));
                            setZipFile(null);
                          }
                        }}
                      />
                      {buildFiles.length > 0 && (
                        <div className="text-sm text-secondary">
                          {buildFiles.length}개 파일 선택됨 ({(buildFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)}MB)
                        </div>
                      )}
                    </>
                  )}

                  {/* 폴더 모드 */}
                  {uploadMode === "folder" && (
                    <>
                      <div
                        className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-accent transition-colors"
                        onClick={() => document.getElementById("build-folder-input")?.click()}
                      >
                        <p className="text-secondary text-sm">클릭하여 폴더 선택</p>
                        <p className="text-xs text-tertiary mt-1">
                          Dockerfile이 포함된 프로젝트 폴더를 통째로 선택하세요
                        </p>
                        <p className="text-xs text-tertiary">
                          .git, node_modules 등 불필요한 파일은 자동 제외됩니다
                        </p>
                      </div>
                      <input
                        id="build-folder-input"
                        type="file"
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        {...({ webkitdirectory: "", directory: "" } as any)}
                        multiple
                        className="hidden"
                        onChange={e => {
                          if (!e.target.files) return;
                          const rawFiles = Array.from(e.target.files);
                          const filtered = rawFiles.filter(f => {
                            const rp = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
                            return !rp.split("/").some(seg => IGNORED_DIRS.has(seg));
                          });
                          if (filtered.length > MAX_UPLOAD_FILES) {
                            alert(`파일이 ${MAX_UPLOAD_FILES}개를 초과합니다. (${filtered.length}개)`);
                            return;
                          }
                          setBuildFiles(filtered);
                          setZipFile(null);
                          e.target.value = "";
                        }}
                      />
                      {buildFiles.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-sm text-secondary">
                            {buildFiles.length}개 파일 선택됨 ({(buildFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)}MB)
                          </div>
                          <div className="max-h-32 overflow-y-auto rounded border border-border bg-bg-secondary p-2">
                            {buildFiles.slice(0, 20).map((f, i) => {
                              const rp = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
                              return (
                                <div key={i} className="text-xs font-mono text-tertiary truncate">{rp}</div>
                              );
                            })}
                            {buildFiles.length > 20 && (
                              <div className="text-xs text-tertiary mt-1">... 외 {buildFiles.length - 20}개</div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* ZIP 모드 */}
                  {uploadMode === "zip" && (
                    <>
                      <div
                        className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-accent transition-colors"
                        onClick={() => document.getElementById("build-zip-input")?.click()}
                      >
                        <p className="text-secondary text-sm">클릭하여 ZIP 파일 선택</p>
                        <p className="text-xs text-tertiary mt-1">Dockerfile + 소스코드 폴더를 ZIP으로 압축하여 업로드 (최대 200MB)</p>
                        <p className="text-xs text-tertiary">서버에서 자동 해제 후 빌드에 사용됩니다</p>
                      </div>
                      <input
                        id="build-zip-input"
                        type="file"
                        accept=".zip"
                        className="hidden"
                        onChange={e => {
                          if (e.target.files?.[0]) {
                            setZipFile(e.target.files[0]);
                            setBuildFiles([]);
                          }
                        }}
                      />
                      {zipFile && (
                        <div className="flex items-center gap-2 text-sm text-secondary">
                          <span className="font-mono">{zipFile.name}</span>
                          <span className="text-xs text-tertiary">({(zipFile.size / 1024 / 1024).toFixed(1)}MB)</span>
                          <button type="button" onClick={() => setZipFile(null)} className="text-red-400 hover:text-red-300 ml-auto">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {form.env_type !== "connection_info" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-secondary">
                    컨테이너 포트 {form.env_type === "image" ? "*" : "(자동 감지 가능)"}
                  </label>
                  <input
                    type="number"
                    value={form.container_port}
                    onChange={e => setForm(f => ({ ...f, container_port: e.target.value }))}
                    placeholder="예: 8080"
                    className="w-full px-3 py-2 bg-card border border-border rounded-lg text-primary"
                  />
                </div>
              )}

              {form.env_type === "connection_info" && (
                <FormField label="접속 정보" required>
                  <textarea
                    value={form.connection_info}
                    onChange={(e) => setForm({ ...form, connection_info: e.target.value })}
                    placeholder={"예: http://10.1.x.10/\n예: nc TEAM_IP 31337\n예: guest / guest1234"}
                    rows={4}
                    className="form-input resize-none"
                  />
                  <p className="mt-1 text-xs text-text-muted">
                    참가자에게 전달할 URL, 포트, 계정, 접속 절차를 자유롭게 적습니다.
                  </p>
                </FormField>
              )}

              <FlagSlotEditor
                slots={form.flag_slots}
                onChange={(slots) => setForm({ ...form, flag_slots: slots })}
              />

              {/* 헬스체크 엔드포인트 */}
              <FormField label="헬스체크 엔드포인트">
                <input
                  type="text"
                  value={form.health_check_endpoint}
                  onChange={(e) =>
                    setForm({ ...form, health_check_endpoint: e.target.value })
                  }
                  placeholder="예: /healthz (비우면 자동 감지 시도)"
                  className="form-input font-mono text-xs"
                />
                <p className="mt-1 text-xs text-text-muted">
                  SLA 감시에 사용됩니다. Dockerfile 업로드 시 HEALTHCHECK 지시어 또는 빌드 후 probing으로 자동 감지를 시도합니다.
                </p>
              </FormField>

              <HealthCheckScenarioEditor
                value={form.healthcheck_scenarios}
                onChange={(healthcheck_scenarios) => setForm({ ...form, healthcheck_scenarios })}
                disabled={isSubmitting}
              />

              {/* 설명 */}
              <FormField label="설명">
                <textarea
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  placeholder="문제에 대한 간단한 설명"
                  rows={3}
                  className="form-input resize-none"
                />
              </FormField>

              </div>

              {/* 하단 버튼 (고정) */}
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
                  disabled={
                    isSubmitting ||
                    !form.name.trim() ||
                    (form.env_type === "image" && !form.docker_image.trim()) ||
                    (form.env_type === "connection_info" && !form.connection_info.trim())
                  }
                  className={cn(
                    "px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent/80 text-white transition-colors",
                    (isSubmitting ||
                      !form.name.trim() ||
                      ((form.env_type === "image" && !form.docker_image.trim()) ||
                        (form.env_type === "connection_info" && !form.connection_info.trim()))) &&
                      "opacity-50 cursor-not-allowed",
                  )}
                >
                  {isSubmitting ? "등록 중..." : "등록"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── 편집 모달 ──────────────────────────────────── */}
      <Dialog.Root open={editOpen} onOpenChange={setEditOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(960px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 bg-bg-elevated border border-border rounded-xl shadow-2xl focus:outline-none flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
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
                문제 수정
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-secondary">
                draft 상태에서만 수정할 수 있습니다. 저장 시 즉시 반영됩니다.
              </Dialog.Description>
            </div>

            {editForm && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleEditSubmit(); }}
                className="flex flex-col flex-1 min-h-0"
              >
                <div className="px-6 pt-5 pb-4 space-y-4 overflow-y-auto flex-1">
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
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </FormField>

                  <FormField label="총점">
                    <div className="form-input flex items-center justify-between">
                      <span>
                        {editForm.flag_slots.reduce((sum, slot) => sum + (Number(slot.points) || 0), 0)}점
                      </span>
                      <span className="text-xs text-text-muted">슬롯별 점수 합계</span>
                    </div>
                  </FormField>

                  {selected?.env_type !== "connection_info" && (
                    <FormField label="Docker 이미지">
                      <input
                        type="text"
                        className="form-input font-mono text-xs"
                        value={editForm.docker_image}
                        onChange={(e) => setEditForm({ ...editForm, docker_image: e.target.value })}
                        placeholder="예: registry.cstrike.io/vuln-web-sqli:latest"
                      />
                    </FormField>
                  )}

                  {selected?.env_type === "connection_info" && (
                    <FormField label="접속 정보">
                      <textarea
                        className="form-input resize-none"
                        rows={4}
                        value={editForm.connection_info}
                        onChange={(e) => setEditForm({ ...editForm, connection_info: e.target.value })}
                        placeholder={"예: http://10.1.x.10/\n예: nc TEAM_IP 31337\n예: guest / guest1234"}
                      />
                    </FormField>
                  )}

                      <FlagSlotEditor
                        slots={editForm.flag_slots}
                        onChange={(slots) => setEditForm({ ...editForm, flag_slots: slots })}
                      />

                  <FormField label="헬스체크 엔드포인트">
                    <input
                      type="text"
                      className="form-input font-mono text-xs"
                      value={editForm.health_check_endpoint}
                      onChange={(e) => setEditForm({ ...editForm, health_check_endpoint: e.target.value })}
                      placeholder="예: /healthz (비우면 TCP 체크)"
                    />
                    <p className="mt-1 text-xs text-text-muted">
                      SLA 감시 정확도 향상용. 웹 서비스는 권장, 포너블/네트워크는 비워도 OK.
                    </p>
                  </FormField>

                  <HealthCheckScenarioEditor
                    value={editForm.healthcheck_scenarios}
                    onChange={(healthcheck_scenarios) => setEditForm({ ...editForm, healthcheck_scenarios })}
                    disabled={isEditSubmitting}
                  />

                  <FormField label="설명">
                    <textarea
                      className="form-input resize-none"
                      rows={3}
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    />
                  </FormField>
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
                    disabled={isEditSubmitting || !editForm.name.trim()}
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

      {/* ── 인라인 스타일 (폼 필드 공통) ───────────────── */}
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

      {/* ── 토스트 알림 ──────────────────────────────────── */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2 w-96">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                "flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-lg border text-sm backdrop-blur-sm animate-in slide-in-from-right duration-200",
                t.type === "success" && "bg-bg-elevated border-status-ok/30 text-status-ok",
                t.type === "error" && "bg-bg-elevated border-status-danger/30 text-status-danger",
                t.type === "building" && "bg-bg-elevated border-status-info/30 text-status-info",
              )}
            >
              {t.type === "building" && <Loader2 className="w-4 h-4 animate-spin shrink-0 mt-0.5" />}
              {t.type === "success" && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
              {t.type === "error" && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span className="flex-1 text-text-primary">{t.message}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
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

/* ─── 공용 서브 컴포넌트 ──────────────────────────────── */

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
          "text-text-primary text-right truncate",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </span>
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
  children: React.ReactNode;
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
