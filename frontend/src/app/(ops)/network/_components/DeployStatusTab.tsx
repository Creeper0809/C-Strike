"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle,
  Rocket,
  Clock,
  AlertTriangle,
  RefreshCw,
  Network,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { DeployStatusResponse, DeployStatusType } from "@/types/ops";

/* ─── Props ──────────────────────────────────────────── */

interface DeployStatusTabProps {
  competitionId: string;
}

/* ─── 상수 ───────────────────────────────────────────── */

const REFRESH_INTERVAL_MS = 10_000;

const DEPLOY_STATUS_CONFIG: Record<
  DeployStatusType,
  { label: string; className: string }
> = {
  completed: {
    label: "완료",
    className: "bg-status-ok/15 text-status-ok",
  },
  deploying: {
    label: "배포 중",
    className: "bg-status-info/15 text-status-info",
  },
  failed: {
    label: "실패",
    className: "bg-status-danger/15 text-status-danger",
  },
  pending: {
    label: "대기",
    className: "bg-amber-400/15 text-amber-400",
  },
  no_subnet: {
    label: "VPN 대역 미등록",
    className: "bg-neutral-500/15 text-neutral-400",
  },
};

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

/* ─── 개요 카드 ──────────────────────────────────────── */

function OverviewCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  color: "ok" | "info" | "neutral";
}) {
  const colorMap = {
    ok: "text-status-ok",
    info: "text-status-info",
    neutral: "text-text-muted",
  };
  const iconColorMap = {
    ok: "text-status-ok",
    info: "text-status-info",
    neutral: "text-text-muted",
  };
  const bgMap = {
    ok: "bg-status-ok/10",
    info: "bg-status-info/10",
    neutral: "bg-neutral-500/10",
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

/* ─── 메인 탭 컴포넌트 ──────────────────────────────── */

export default function DeployStatusTab({ competitionId }: DeployStatusTabProps) {
  /* 상태 */
  const [data, setData] = useState<DeployStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ── 데이터 조회 ─────────────────────────────────── */

  const fetchDeployStatus = useCallback(async () => {
    if (!competitionId) return;

    try {
      const res = await apiFetch<DeployStatusResponse>(
        `/v1/competitions/${competitionId}/network/deploy-status`,
      );
      setData(res);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "배포 현황을 불러올 수 없습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  /* 10초 자동 갱신 */
  useEffect(() => {
    fetchDeployStatus();
    const interval = setInterval(fetchDeployStatus, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [competitionId, fetchDeployStatus]);

  /* ── 로딩 상태 ───────────────────────────────────── */

  if (loading) {
    return (
      <div className="space-y-6">
        {/* 개요 카드 스켈레톤 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

        {/* 테이블 스켈레톤 */}
        <div className="bg-bg-secondary border border-border rounded-xl p-5 animate-pulse">
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-4 bg-bg-tertiary rounded w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ── 에러 상태 ───────────────────────────────────── */

  if (error && !data) {
    return (
      <div className="bg-bg-secondary border border-border rounded-xl p-8 flex flex-col items-center gap-4">
        <AlertTriangle className="w-8 h-8 text-status-warning" />
        <p className="text-sm text-status-danger">{error}</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setError(null);
            fetchDeployStatus();
          }}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/80 text-white text-sm rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          재시도
        </button>
      </div>
    );
  }

  if (!data) return null;

  /* ── 대기/미등록 카운트 계산 ─────────────────────── */

  const pendingCount =
    data.total_teams - data.deployed_count - data.deploying_count;

  /* ── 렌더링 ──────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* ── 1. 요약 카드 3열 ───────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <OverviewCard
          label="배포 완료"
          value={data.deployed_count}
          icon={CheckCircle}
          color="ok"
        />
        <OverviewCard
          label="배포 중"
          value={data.deploying_count}
          icon={Rocket}
          color="info"
        />
        <OverviewCard
          label="대기/미등록"
          value={pendingCount}
          icon={Clock}
          color="neutral"
        />
      </div>

      {/* 갱신 실패 경고 */}
      {error && data && (
        <div className="flex items-center gap-2 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>최신 상태 갱신 실패</span>
        </div>
      )}

      {/* ── 2. 팀별 배포 상태 테이블 ─────────────── */}
      {data.teams.length === 0 ? (
        <div className="bg-bg-secondary border border-border rounded-xl p-8 flex flex-col items-center gap-3">
          <Network className="w-8 h-8 text-text-muted" />
          <p className="text-sm text-text-muted">등록된 팀이 없습니다.</p>
        </div>
      ) : (
        <div className="bg-bg-secondary rounded-xl overflow-hidden border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className="px-4 py-3 font-medium text-text-muted text-left">
                  팀
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-left">
                  VPN 대역
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-left">
                  취약점팩
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-center">
                  배포 상태
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-center">
                  진행률
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-right">
                  마지막 배포
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.teams.map((team) => {
                const statusCfg = DEPLOY_STATUS_CONFIG[team.deploy_status];

                return (
                  <tr
                    key={team.team_id}
                    className="hover:bg-bg-tertiary/30 transition-colors"
                  >
                    {/* 팀 이름 */}
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">
                        {team.team_name}
                      </p>
                    </td>

                    {/* 서브넷 */}
                    <td className="px-4 py-3">
                      {team.subnet ? (
                        <span className="font-mono text-text-primary">
                          {team.subnet}
                        </span>
                      ) : (
                        <span className="italic text-text-muted">미등록</span>
                      )}
                    </td>

                    {/* 취약점팩 */}
                    <td className="px-4 py-3">
                      {team.vulnpack_name ? (
                        <span className="text-text-primary">
                          {team.vulnpack_name}
                        </span>
                      ) : (
                        <span className="text-text-muted">-</span>
                      )}
                    </td>

                    {/* 배포 상태 */}
                    <td className="px-4 py-3 text-center">
                      <span
                        className={cn(
                          "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
                          statusCfg.className,
                        )}
                      >
                        {statusCfg.label}
                      </span>
                    </td>

                    {/* 진행률 */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-bg-tertiary rounded-full h-1.5">
                          <div
                            className="bg-status-ok h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${team.progress_pct}%` }}
                          />
                        </div>
                        <span className="text-xs font-mono text-text-muted w-9 text-right">
                          {team.progress_pct}%
                        </span>
                      </div>
                    </td>

                    {/* 마지막 배포 */}
                    <td className="px-4 py-3 text-right text-text-secondary">
                      {formatDateTime(team.last_deploy_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
