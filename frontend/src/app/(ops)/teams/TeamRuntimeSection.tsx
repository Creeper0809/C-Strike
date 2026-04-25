"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import StatusIndicator from "@/components/ui/StatusIndicator";
import type { TeamServiceItem } from "@/types/ops";

interface RuntimeContainerItem {
  container_id: string;
  name: string;
  status: string;
  team_id: string;
  team_code: string;
  service_id: string;
  service_name: string;
  image: string;
  created: string;
}

interface ContainerLogsResponse {
  container_id: string;
  logs: string;
}

const CONTAINER_STATUS_MAP: Record<
  string,
  { label: string; color: "ok" | "neutral" | "warning" | "danger" }
> = {
  running: { label: "실행 중", color: "ok" },
  exited: { label: "종료됨", color: "neutral" },
  stopped: { label: "중지됨", color: "neutral" },
  created: { label: "생성됨", color: "warning" },
  restarting: { label: "재시작 중", color: "warning" },
  paused: { label: "일시중지", color: "warning" },
  dead: { label: "비정상 종료", color: "danger" },
  error: { label: "오류", color: "danger" },
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getContainerStatus(status: string) {
  return (
    CONTAINER_STATUS_MAP[status] ?? {
      label: status || "알 수 없음",
      color: "neutral" as const,
    }
  );
}

export default function TeamRuntimeSection({
  teamId,
  teamName,
  services,
  embedded = false,
}: {
  teamId: string;
  teamName: string;
  services: TeamServiceItem[];
  embedded?: boolean;
}) {
  const [showRuntime, setShowRuntime] = useState(false);
  const [containers, setContainers] = useState<RuntimeContainerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLogContainerId, setSelectedLogContainerId] = useState<string | null>(
    null,
  );
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);

  const fetchRuntime = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const raw = await apiFetch<RuntimeContainerItem[]>("/containers/");
      setContainers(raw.filter((item) => item.team_id === teamId));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "런타임 컨테이너 정보를 불러오지 못했습니다.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    if (!embedded && !showRuntime) return;
    fetchRuntime();
  }, [embedded, fetchRuntime, showRuntime]);

  const containerMapByService = useMemo(() => {
    const map = new Map<string, RuntimeContainerItem[]>();
    for (const container of containers) {
      const list = map.get(container.service_id) ?? [];
      list.push(container);
      map.set(container.service_id, list);
    }
    return map;
  }, [containers]);

  const orphanContainers = useMemo(() => {
    const serviceIds = new Set(services.map((svc) => svc.service_id));
    return containers.filter((container) => !serviceIds.has(container.service_id));
  }, [containers, services]);

  async function handleLoadLogs(container: RuntimeContainerItem) {
    setSelectedLogContainerId(container.container_id);
    setLogsLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ContainerLogsResponse>(
        `/containers/${container.container_id}/logs`,
      );
      setLogs(data.logs);
    } catch (err) {
      setLogs(
        `[오류] ${
          err instanceof Error ? err.message : "컨테이너 로그를 불러오지 못했습니다."
        }`,
      );
    } finally {
      setLogsLoading(false);
    }
  }

  async function handleStop(container: RuntimeContainerItem) {
    const key = `stop:${container.container_id}`;
    setActionKey(key);
    setError(null);
    try {
      await apiFetch(`/containers/${container.container_id}/stop`, {
        method: "POST",
        body: JSON.stringify({ reason: "운영자 수동 중단" }),
      });
      await fetchRuntime();
      if (selectedLogContainerId === container.container_id) {
        await handleLoadLogs(container);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "컨테이너 중단에 실패했습니다.",
      );
    } finally {
      setActionKey(null);
    }
  }

  async function handleReset(serviceId: string) {
    const key = `reset:${serviceId}`;
    setActionKey(key);
    setError(null);
    try {
      await apiFetch(`/containers/teams/${teamId}/services/${serviceId}/reset`, {
        method: "POST",
        body: JSON.stringify({ reason: "운영자 런타임 리셋" }),
      });
      setSelectedLogContainerId(null);
      setLogs(null);
      await fetchRuntime();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "서비스 런타임 리셋에 실패했습니다.",
      );
    } finally {
      setActionKey(null);
    }
  }

  const selectedLogContainer =
    containers.find((container) => container.container_id === selectedLogContainerId) ??
    null;

  const content = (
    <div className={cn("space-y-4", !embedded && "border-t border-border px-5 py-4")}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {teamName} 팀에 배포된 컨테이너의 실제 실행 상태와 로그를 확인하고,
          중단 또는 서비스 리셋을 수행합니다.
        </p>
        <button
          type="button"
          onClick={fetchRuntime}
          className="inline-flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
          새로고침
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          {services.length === 0 && containers.length === 0 ? (
            <p className="text-sm text-text-muted py-4">
              아직 이 팀에 배포된 서비스가 없습니다.
            </p>
          ) : (
            <div className="space-y-4">
              {services.map((service) => {
                const matchedContainers =
                  containerMapByService.get(service.service_id) ?? [];
                const runningCount = matchedContainers.filter(
                  (container) => container.status === "running",
                ).length;

                return (
                  <div
                    key={service.id}
                    className="rounded-lg border border-border bg-bg-primary/40"
                  >
                    <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-border">
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          {service.service_name || service.service_id}
                        </p>
                        <p className="mt-1 text-xs text-text-muted font-mono">
                          {service.host_ip}:{service.port}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <StatusIndicator
                            status={
                              service.status === "running"
                                ? "ok"
                                : service.status === "stopped"
                                  ? "neutral"
                                  : "warning"
                            }
                            label={`서비스 ${service.status}`}
                            size="sm"
                          />
                          <StatusIndicator
                            status={runningCount > 0 ? "ok" : "neutral"}
                            label={`컨테이너 ${matchedContainers.length}개`}
                            size="sm"
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleReset(service.service_id)}
                        disabled={
                          matchedContainers.length === 0 ||
                          actionKey === `reset:${service.service_id}`
                        }
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                          matchedContainers.length > 0
                            ? "bg-status-warning text-white hover:bg-status-warning/80"
                            : "bg-bg-tertiary text-text-muted cursor-not-allowed",
                        )}
                      >
                        {actionKey === `reset:${service.service_id}` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5" />
                        )}
                        서비스 리셋
                      </button>
                    </div>

                    <div className="px-4 py-3">
                      {matchedContainers.length === 0 ? (
                        <p className="text-xs text-text-muted">
                          현재 감지된 런타임 컨테이너가 없습니다.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {matchedContainers.map((container) => {
                            const statusInfo = getContainerStatus(container.status);
                            const isSelectedLog =
                              selectedLogContainerId === container.container_id;
                            const stopKey = `stop:${container.container_id}`;

                            return (
                              <div
                                key={container.container_id}
                                className="rounded-lg bg-bg-secondary border border-border px-3 py-3"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="text-sm font-medium text-text-primary break-all">
                                        {container.name}
                                      </p>
                                      <StatusIndicator
                                        status={statusInfo.color}
                                        label={statusInfo.label}
                                        size="sm"
                                      />
                                    </div>
                                    <p className="mt-1 text-xs text-text-muted font-mono break-all">
                                      {container.image}
                                    </p>
                                    <p className="mt-1 text-xs text-text-muted font-mono">
                                      ID {container.container_id.slice(0, 12)} · 생성{" "}
                                      {formatDateTime(container.created)}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => handleLoadLogs(container)}
                                      className={cn(
                                        "inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                                        isSelectedLog
                                          ? "bg-accent text-white"
                                          : "bg-bg-tertiary text-text-secondary hover:text-text-primary",
                                      )}
                                    >
                                      <Terminal className="w-3.5 h-3.5" />
                                      로그
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleStop(container)}
                                      disabled={actionKey === stopKey}
                                      className="inline-flex items-center gap-1 rounded-lg bg-status-danger/10 px-2.5 py-1.5 text-xs text-status-danger hover:bg-status-danger/20 transition-colors disabled:opacity-50"
                                    >
                                      {actionKey === stopKey ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : (
                                        <Square className="w-3.5 h-3.5" />
                                      )}
                                      중단
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {orphanContainers.length > 0 && (
                <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 px-4 py-3">
                  <p className="text-sm font-medium text-text-primary">
                    서비스 매핑이 없는 컨테이너
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    삭제되었거나 매핑이 끊긴 서비스의 잔여 컨테이너일 수 있습니다.
                  </p>
                  <div className="mt-3 space-y-2">
                    {orphanContainers.map((container) => (
                      <div
                        key={container.container_id}
                        className="rounded-lg border border-border bg-bg-secondary px-3 py-2"
                      >
                        <p className="text-sm text-text-primary">{container.name}</p>
                        <p className="mt-1 text-xs text-text-muted font-mono">
                          {container.service_name || container.service_id} · ID{" "}
                          {container.container_id.slice(0, 12)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-border bg-bg-primary/60">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <p className="text-sm font-medium text-text-primary">로그 뷰어</p>
                <p className="mt-1 text-xs text-text-muted">
                  {selectedLogContainer
                    ? `${selectedLogContainer.name} 로그`
                    : "컨테이너에서 로그 버튼을 눌러 선택하세요."}
                </p>
              </div>
              {selectedLogContainer && (
                <button
                  type="button"
                  onClick={() => handleLoadLogs(selectedLogContainer)}
                  className="inline-flex items-center gap-1 rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
                >
                  <RefreshCw
                    className={cn("w-3.5 h-3.5", logsLoading && "animate-spin")}
                  />
                  다시 읽기
                </button>
              )}
            </div>
            <div className="px-4 py-3">
              {logsLoading && !logs ? (
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  로그를 불러오는 중입니다.
                </div>
              ) : logs ? (
                <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-bg-secondary px-3 py-3 text-xs text-text-secondary font-mono">
                  {logs}
                </pre>
              ) : (
                <p className="text-sm text-text-muted">표시할 로그가 없습니다.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );

  return (
    <section className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
      {embedded ? (
        <div className="px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <Box className="w-4 h-4 text-text-muted" />
            <h3 className="text-sm font-semibold text-text-primary">런타임</h3>
            <span className="text-xs text-text-muted">
              {containers.length}개 컨테이너
            </span>
          </div>
          {content}
        </div>
      ) : (
        <>
          <button
            onClick={() => setShowRuntime((value) => !value)}
            className="w-full flex items-center justify-between px-5 py-4 text-left"
          >
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Box className="w-4 h-4 text-text-muted" />
              런타임
              <span className="ml-1 text-xs font-normal text-text-muted">
                ({containers.length}개 컨테이너)
              </span>
            </h3>
            {showRuntime ? (
              <ChevronUp className="w-4 h-4 text-text-muted" />
            ) : (
              <ChevronDown className="w-4 h-4 text-text-muted" />
            )}
          </button>
          {showRuntime && content}
        </>
      )}
    </section>
  );
}
