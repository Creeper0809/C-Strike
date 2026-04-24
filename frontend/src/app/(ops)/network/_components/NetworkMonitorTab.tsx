"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Network,
  Shield,
  ShieldOff,
  ShieldAlert,
  Wifi,
  WifiOff,
  X,
  AlertTriangle,
  RefreshCw,
  Activity,
  Globe,
  Server,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { NETWORK_STATUS_MAP, STATUS_COLORS } from "@/lib/constants";
import StatusIndicator from "@/components/ui/StatusIndicator";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type {
  NetworkStatusResponse,
  NetworkTeamSummary,
  NetworkTeamDetail,
  NetworkActionResponse,
} from "@/types/ops";

interface NetworkMonitorTabProps {
  competitionId: string;
}

/* ─── 상수 ────────────────────────────────────────────── */

const REFRESH_INTERVAL_MS = 10_000;

/* ─── 헬퍼 함수 ──────────────────────────────────────── */

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function getPingColor(ping: number | null): string {
  if (ping === null) return "text-text-muted";
  if (ping < 50) return "text-status-ok";
  if (ping < 200) return "text-status-warning";
  return "text-status-danger";
}

function getStatusLevel(status: string): "ok" | "danger" {
  return status === "connected" ? "ok" : "danger";
}

/* ─── 개요 카드 컴포넌트 ──────────────────────────────── */

function OverviewCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  color: "default" | "ok" | "danger";
}) {
  const colorMap = {
    default: "text-text-primary",
    ok: "text-status-ok",
    danger: "text-status-danger",
  };
  const iconColorMap = {
    default: "text-accent",
    ok: "text-status-ok",
    danger: "text-status-danger",
  };
  const bgMap = {
    default: "bg-accent/10",
    ok: "bg-status-ok/10",
    danger: "bg-status-danger/10",
  };

  return (
    <div className="bg-bg-secondary border border-border rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div
          className={cn(
            "w-9 h-9 rounded-lg flex items-center justify-center",
            bgMap[color],
          )}
        >
          <Icon className={cn("w-5 h-5", iconColorMap[color])} />
        </div>
        <span className="text-sm text-text-secondary">{label}</span>
      </div>
      <p className={cn("text-3xl font-bold font-mono", colorMap[color])}>
        {value}
      </p>
    </div>
  );
}

/* ─── 팀 네트워크 카드 ───────────────────────────────── */

function TeamNetworkCard({
  team,
  onClick,
  onIsolate,
  onRestore,
}: {
  team: NetworkTeamSummary;
  onClick: () => void;
  onIsolate: () => void;
  onRestore: () => void;
}) {
  const isIsolated = team.status === "isolated";
  const mapped = NETWORK_STATUS_MAP[team.status];
  const statusColor = mapped?.color ?? "neutral";

  return (
    <div
      className={cn(
        "bg-bg-secondary rounded-xl border p-5 transition-colors cursor-pointer group",
        isIsolated
          ? "border-status-danger/40 hover:border-status-danger/60"
          : "border-border hover:border-accent/40",
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* 카드 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <StatusIndicator status={getStatusLevel(team.status)} />
          <h3 className="text-sm font-semibold text-text-primary truncate">
            {team.team_name}
          </h3>
        </div>
        <span
          className={cn(
            "inline-flex px-2 py-0.5 rounded-full text-xs font-medium shrink-0",
            isIsolated
              ? "bg-status-danger/15 text-status-danger"
              : "bg-status-ok/15 text-status-ok",
          )}
        >
          {mapped?.label ?? team.status}
        </span>
      </div>

      {/* 네트워크 정보 */}
      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-text-muted">VPN 대역</span>
          <span className="font-mono text-text-secondary">
            {team.subnet ?? "-"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">팀 서버 IP</span>
          <span className="font-mono text-text-secondary">
            {team.gateway_ip ?? "-"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">핑</span>
          <span className={cn("font-mono font-medium", getPingColor(team.ping_ms))}>
            {team.ping_ms !== null ? `${team.ping_ms}ms` : "-"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">마지막 체크</span>
          <span className="text-text-secondary">
            {formatDateTime(team.last_checked_at)}
          </span>
        </div>
      </div>

      {/* 격리 사유 (격리된 경우만) */}
      {isIsolated && team.isolation_reason && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-xs text-status-danger/80">
            <span className="font-medium">격리 사유:</span>{" "}
            {team.isolation_reason}
          </p>
          {team.isolated_at && (
            <p className="text-xs text-text-muted mt-1">
              격리 시각: {formatDateTime(team.isolated_at)}
            </p>
          )}
        </div>
      )}

      {/* 격리/복구 버튼 */}
      <div className="mt-4 pt-3 border-t border-border">
        {isIsolated ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-status-ok/15 text-status-ok hover:bg-status-ok/25 transition-colors"
          >
            <Shield className="w-3.5 h-3.5" />
            네트워크 복구
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIsolate();
            }}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-status-danger/15 text-status-danger hover:bg-status-danger/25 transition-colors"
          >
            <ShieldOff className="w-3.5 h-3.5" />
            네트워크 격리
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── 팀 상세 드로어 ─────────────────────────────────── */

function TeamDetailDrawer({
  teamId,
  competitionId,
  onClose,
}: {
  teamId: string;
  competitionId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<NetworkTeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchDetail() {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<NetworkTeamDetail>(
          `/v1/competitions/${competitionId}/network/teams/${teamId}`,
        );
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "상세 정보를 불러올 수 없습니다.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDetail();
    return () => {
      cancelled = true;
    };
  }, [teamId, competitionId]);

  const isIsolated = detail?.status === "isolated";

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md bg-bg-secondary border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
      {/* 드로어 헤더 */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
        <h2 className="text-base font-semibold text-text-primary">
          팀 네트워크 상세
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          aria-label="닫기"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 드로어 콘텐츠 */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent animate-spin" />
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center gap-3 py-8">
            <AlertTriangle className="w-6 h-6 text-status-warning" />
            <p className="text-sm text-status-danger">{error}</p>
          </div>
        )}

        {detail && !loading && (
          <>
            {/* 팀 기본 정보 */}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <StatusIndicator
                  status={getStatusLevel(detail.status)}
                  label={NETWORK_STATUS_MAP[detail.status]?.label ?? detail.status}
                />
              </div>
              <h3 className="text-lg font-bold text-text-primary">
                {detail.team_name}
              </h3>
            </div>

            {/* 네트워크 상세 */}
            <div className="bg-bg-tertiary rounded-lg p-4 space-y-3">
              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                네트워크 정보
              </h4>
              <DetailRow label="VPN 대역" value={detail.subnet ?? "-"} mono />
              <DetailRow label="팀 서버 IP" value={detail.gateway_ip ?? "-"} mono />
              <DetailRow
                label="핑"
                value={detail.ping_ms !== null ? `${detail.ping_ms}ms` : "-"}
                mono
                valueClassName={getPingColor(detail.ping_ms)}
              />
              <DetailRow
                label="VPN 프로필"
                value={detail.vpn_profile_issued ? "발급됨" : "미발급"}
              />
              <DetailRow
                label="활성 연결"
                value={String(detail.active_connections)}
                mono
              />
              <DetailRow
                label="마지막 체크"
                value={formatDateTime(detail.last_checked_at)}
              />
            </div>

            {/* 서비스별 연결 상태 */}
            <div>
              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
                서비스 연결 상태
              </h4>
              {detail.services.length === 0 ? (
                <p className="text-sm text-text-muted py-4 text-center">
                  등록된 서비스가 없습니다.
                </p>
              ) : (
                <div className="bg-bg-tertiary rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="px-3 py-2.5 font-medium text-text-muted">
                          서비스
                        </th>
                        <th className="px-3 py-2.5 font-medium text-text-muted">
                          IP:포트
                        </th>
                        <th className="px-3 py-2.5 font-medium text-text-muted text-center">
                          상태
                        </th>
                        <th className="px-3 py-2.5 font-medium text-text-muted text-right">
                          응답
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {detail.services.map((svc) => (
                        <tr
                          key={`${svc.host_ip}:${svc.port}`}
                          className="hover:bg-bg-secondary/50"
                        >
                          <td className="px-3 py-2.5 text-text-primary font-medium">
                            {svc.service_name}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-text-secondary">
                            {svc.host_ip}:{svc.port}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {svc.reachable ? (
                              <CheckCircle className="w-3.5 h-3.5 text-status-ok inline-block" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5 text-status-danger inline-block" />
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono">
                            <span className={getPingColor(svc.response_time_ms)}>
                              {svc.response_time_ms !== null
                                ? `${svc.response_time_ms}ms`
                                : "-"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── 상세 행 (드로어용) ─────────────────────────────── */

function DetailRow({
  label,
  value,
  mono = false,
  valueClassName,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="flex justify-between items-baseline gap-4">
      <span className="text-text-muted text-xs shrink-0">{label}</span>
      <span
        className={cn(
          "text-sm text-right truncate",
          mono && "font-mono text-xs",
          valueClassName ?? "text-text-primary",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/* ─── 메인 탭 컴포넌트 ───────────────────────────────── */

export default function NetworkMonitorTab({ competitionId }: NetworkMonitorTabProps) {
  /* 상태 */
  const [networkStatus, setNetworkStatus] = useState<NetworkStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* 드로어 */
  const [drawerTeamId, setDrawerTeamId] = useState<string | null>(null);

  /* 모달 상태 */
  const [modalType, setModalType] = useState<
    | null
    | "isolate"
    | "restore"
    | "isolate-all"
    | "restore-all"
  >(null);
  const [modalTargetTeam, setModalTargetTeam] = useState<NetworkTeamSummary | null>(null);
  const [modalReason, setModalReason] = useState("");
  const [modalLoading, setModalLoading] = useState(false);

  /* ── 네트워크 상태 조회 ────────────────────────────── */

  const fetchNetworkStatus = useCallback(async () => {
    if (!competitionId) return;

    try {
      const data = await apiFetch<NetworkStatusResponse>(
        `/v1/competitions/${competitionId}/network/status`,
      );
      setNetworkStatus(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "네트워크 상태를 불러올 수 없습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    if (!competitionId) return;

    fetchNetworkStatus();
    const interval = setInterval(fetchNetworkStatus, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [competitionId, fetchNetworkStatus]);

  /* ── 격리/복구 액션 ────────────────────────────────── */

  async function handleIsolateTeam() {
    if (!modalTargetTeam || !competitionId || !modalReason.trim()) return;

    setModalLoading(true);
    try {
      await apiFetch<NetworkActionResponse>(
        `/v1/competitions/${competitionId}/network/teams/${modalTargetTeam.team_id}/isolate`,
        {
          method: "POST",
          body: JSON.stringify({ reason: modalReason.trim() }),
        },
      );
      closeModal();
      await fetchNetworkStatus();
    } catch {
      // ConfirmModal이 닫히지 않으므로 사용자가 재시도 가능
    } finally {
      setModalLoading(false);
    }
  }

  async function handleRestoreTeam() {
    if (!modalTargetTeam || !competitionId || !modalReason.trim()) return;

    setModalLoading(true);
    try {
      await apiFetch<NetworkActionResponse>(
        `/v1/competitions/${competitionId}/network/teams/${modalTargetTeam.team_id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ reason: modalReason.trim() }),
        },
      );
      closeModal();
      await fetchNetworkStatus();
    } catch {
      // 재시도 가능
    } finally {
      setModalLoading(false);
    }
  }

  async function handleIsolateAll() {
    if (!competitionId || !modalReason.trim()) return;

    setModalLoading(true);
    try {
      await apiFetch<NetworkActionResponse>(
        `/v1/competitions/${competitionId}/network/isolate-all`,
        {
          method: "POST",
          body: JSON.stringify({ reason: modalReason.trim() }),
        },
      );
      closeModal();
      await fetchNetworkStatus();
    } catch {
      // 재시도 가능
    } finally {
      setModalLoading(false);
    }
  }

  async function handleRestoreAll() {
    if (!competitionId || !modalReason.trim()) return;

    setModalLoading(true);
    try {
      await apiFetch<NetworkActionResponse>(
        `/v1/competitions/${competitionId}/network/restore-all`,
        {
          method: "POST",
          body: JSON.stringify({ reason: modalReason.trim() }),
        },
      );
      closeModal();
      await fetchNetworkStatus();
    } catch {
      // 재시도 가능
    } finally {
      setModalLoading(false);
    }
  }

  function openModal(
    type: "isolate" | "restore" | "isolate-all" | "restore-all",
    team?: NetworkTeamSummary,
  ) {
    setModalType(type);
    setModalTargetTeam(team ?? null);
    setModalReason("");
    setModalLoading(false);
  }

  function closeModal() {
    setModalType(null);
    setModalTargetTeam(null);
    setModalReason("");
    setModalLoading(false);
  }

  function handleModalConfirm() {
    switch (modalType) {
      case "isolate":
        return handleIsolateTeam();
      case "restore":
        return handleRestoreTeam();
      case "isolate-all":
        return handleIsolateAll();
      case "restore-all":
        return handleRestoreAll();
      default:
        return;
    }
  }

  /* ── 모달 설정 ─────────────────────────────────────── */

  const MODAL_CONFIG: Record<
    string,
    { title: string; description: string; confirmLabel: string; variant: "danger" | "default" }
  > = {
    isolate: {
      title: `${modalTargetTeam?.team_name ?? "팀"} 네트워크 격리`,
      description: "해당 팀의 네트워크를 즉시 격리합니다. 격리 사유를 입력하세요.",
      confirmLabel: "격리 실행",
      variant: "danger",
    },
    restore: {
      title: `${modalTargetTeam?.team_name ?? "팀"} 네트워크 복구`,
      description: "해당 팀의 네트워크를 복구합니다. 복구 사유를 입력하세요.",
      confirmLabel: "복구 실행",
      variant: "default",
    },
    "isolate-all": {
      title: "전체 네트워크 격리",
      description:
        "모든 팀의 네트워크를 즉시 격리합니다. 이 작업은 모든 팀의 네트워크에 즉시 영향을 미칩니다.",
      confirmLabel: "전체 격리 실행",
      variant: "danger",
    },
    "restore-all": {
      title: "전체 네트워크 복구",
      description:
        "모든 팀의 네트워크를 복구합니다. 이 작업은 모든 팀의 네트워크에 즉시 영향을 미칩니다.",
      confirmLabel: "전체 복구 실행",
      variant: "default",
    },
  };

  const currentModalConfig = modalType ? MODAL_CONFIG[modalType] : null;

  /* ── 로딩 상태 ─────────────────────────────────────── */

  if (loading) {
    return (
      <div className="space-y-6">
        {/* 개요 카드 스켈레톤 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-bg-secondary border border-border rounded-xl p-5 animate-pulse"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 bg-bg-tertiary rounded-lg" />
                <div className="h-4 w-20 bg-bg-tertiary rounded" />
              </div>
              <div className="h-9 w-16 bg-bg-tertiary rounded" />
            </div>
          ))}
        </div>

        {/* 그리드 스켈레톤 */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="bg-bg-secondary border border-border rounded-xl p-5 animate-pulse"
            >
              <div className="h-4 w-24 bg-bg-tertiary rounded mb-4" />
              <div className="space-y-2">
                <div className="h-3 bg-bg-tertiary rounded" />
                <div className="h-3 bg-bg-tertiary rounded" />
                <div className="h-3 bg-bg-tertiary rounded w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ── 에러 상태 (데이터 없음) ───────────────────────── */

  if (error && !networkStatus) {
    return (
      <div className="bg-bg-secondary border border-border rounded-xl p-8 flex flex-col items-center gap-4">
        <AlertTriangle className="w-8 h-8 text-status-warning" />
        <p className="text-sm text-status-danger">{error}</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setError(null);
            fetchNetworkStatus();
          }}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/80 text-white text-sm rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          재시도
        </button>
      </div>
    );
  }

  if (!networkStatus) return null;

  /* ── 렌더링 ──────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* 서브넷 정보 배너 */}
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span>참가자 서브넷: <span className="font-mono text-text-secondary">{networkStatus.participant_subnet}</span></span>
        <span>/</span>
        <span>운영 서브넷: <span className="font-mono text-text-secondary">{networkStatus.ops_subnet}</span></span>
        {error && (
          <span className="ml-auto text-status-warning">최신 상태 갱신 실패</span>
        )}
      </div>

      {/* ── 1. 상단 개요 카드 ────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <OverviewCard
          label="전체 팀"
          value={networkStatus.total_teams}
          icon={Globe}
          color="default"
        />
        <OverviewCard
          label="온라인"
          value={networkStatus.teams_online}
          icon={Wifi}
          color="ok"
        />
        <OverviewCard
          label="격리"
          value={networkStatus.teams_isolated}
          icon={WifiOff}
          color="danger"
        />
      </div>

      {/* ── 2. 긴급 제어 영역 ────────────────────────── */}
      <div
        className={cn(
          "rounded-xl border p-5",
          networkStatus.is_all_isolated
            ? "bg-status-danger/5 border-status-danger/30"
            : "bg-bg-secondary border-border",
        )}
      >
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="w-5 h-5 text-text-secondary" />
          <h2 className="text-sm font-semibold text-text-primary">
            긴급 네트워크 제어
          </h2>
        </div>

        <div className="flex flex-wrap gap-3 mb-3">
          {/* 전체 격리 버튼 */}
          <button
            type="button"
            onClick={() => openModal("isolate-all")}
            disabled={networkStatus.is_all_isolated}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors",
              networkStatus.is_all_isolated
                ? "bg-status-danger/20 text-status-danger/50 cursor-not-allowed"
                : "bg-status-danger hover:bg-status-danger/80 text-white",
            )}
          >
            <ShieldOff className="w-4 h-4" />
            전체 격리
          </button>

          {/* 전체 복구 버튼 */}
          <button
            type="button"
            onClick={() => openModal("restore-all")}
            disabled={networkStatus.teams_isolated === 0}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors",
              networkStatus.teams_isolated === 0
                ? "bg-status-ok/20 text-status-ok/50 cursor-not-allowed"
                : "bg-status-ok hover:bg-status-ok/80 text-white",
            )}
          >
            <Shield className="w-4 h-4" />
            전체 복구
          </button>
        </div>

        <p className="text-xs text-text-muted">
          이 작업은 모든 팀의 네트워크에 즉시 영향을 미칩니다.
        </p>
      </div>

      {/* ── 3. 팀 네트워크 카드 그리드 ───────────────── */}
      {networkStatus.teams.length === 0 ? (
        <div className="bg-bg-secondary border border-border rounded-xl p-8 flex flex-col items-center gap-3">
          <Network className="w-8 h-8 text-text-muted" />
          <p className="text-sm text-text-muted">
            등록된 팀이 없습니다.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {networkStatus.teams.map((team) => (
            <TeamNetworkCard
              key={team.team_id}
              team={team}
              onClick={() => setDrawerTeamId(team.team_id)}
              onIsolate={() => openModal("isolate", team)}
              onRestore={() => openModal("restore", team)}
            />
          ))}
        </div>
      )}

      {/* ── 4. 팀 상세 드로어 ────────────────────────── */}
      {drawerTeamId && competitionId && (
        <>
          {/* 백드롭 */}
          <div
            className="fixed inset-0 z-30 bg-black/40"
            onClick={() => setDrawerTeamId(null)}
            aria-hidden="true"
          />
          <TeamDetailDrawer
            teamId={drawerTeamId}
            competitionId={competitionId}
            onClose={() => setDrawerTeamId(null)}
          />
        </>
      )}

      {/* ── 5. 격리/복구 확인 모달 ──────────────────── */}
      {currentModalConfig && (
        <ConfirmModal
          open={modalType !== null}
          onOpenChange={(open) => {
            if (!open) closeModal();
          }}
          title={currentModalConfig.title}
          description={currentModalConfig.description}
          confirmLabel={currentModalConfig.confirmLabel}
          variant={currentModalConfig.variant}
          onConfirm={handleModalConfirm}
          isLoading={modalLoading}
        >
          <div className="space-y-2">
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                사유 (필수)
              </span>
              <textarea
                value={modalReason}
                onChange={(e) => setModalReason(e.target.value)}
                rows={3}
                placeholder="격리/복구 사유를 입력하세요..."
                className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors resize-none"
              />
            </label>
            {!modalReason.trim() && (
              <p className="text-xs text-status-warning">
                사유를 입력해야 실행할 수 있습니다.
              </p>
            )}
          </div>
        </ConfirmModal>
      )}
    </div>
  );
}
