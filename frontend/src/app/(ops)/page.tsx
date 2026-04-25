"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Users,
  Target,
  Ticket,
  Box,
  RefreshCw,
  Activity,
  TrendingUp,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { DashboardStats, AuditLog } from "@/types/ops";

const REFRESH_INTERVAL_MS = 30_000;

const SYSTEM_LABELS: Record<string, string> = {
  scoring: "채점 엔진",
  scoreboard: "스코어보드",
  deploy_service: "배포 서비스",
  cguard: "C-Guard",
  discord_bot: "Discord Bot",
};

const STATUS_STYLES: Record<
  string,
  { dot: string; text: string; pulse: string }
> = {
  ok: {
    dot: "bg-status-ok",
    text: "text-status-ok",
    pulse: "status-pulse-ok",
  },
  degraded: {
    dot: "bg-status-warning",
    text: "text-status-warning",
    pulse: "",
  },
  down: {
    dot: "bg-status-danger",
    text: "text-status-danger",
    pulse: "status-pulse-danger",
  },
  unknown: {
    dot: "bg-status-neutral",
    text: "text-status-neutral",
    pulse: "",
  },
  not_connected: {
    dot: "bg-status-neutral",
    text: "text-text-muted",
    pulse: "",
  },
};

const STATUS_TEXT: Record<string, string> = {
  ok: "정상",
  degraded: "저하",
  down: "중단",
  not_connected: "미연동",
  unknown: "알 수 없음",
};

/* ─────────────────────── StatCardGrid ─────────────────────── */

interface StatCard {
  label: string;
  value: number;
  icon: React.ElementType;
}

function StatCardGrid({ stats }: { stats: DashboardStats }) {
  const cards: StatCard[] = [
    { label: "활성 팀", value: stats.active_teams, icon: Users },
    { label: "채점 라운드", value: stats.scoring_round, icon: Target },
    { label: "열린 티켓", value: stats.open_tickets, icon: Ticket },
    { label: "실행 컨테이너", value: stats.running_containers, icon: Box },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="bg-bg-secondary border border-border rounded-xl p-5 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary uppercase tracking-wider">
                {card.label}
              </span>
              <Icon className="w-4 h-4 text-text-muted" />
            </div>
            <span className="text-3xl font-bold font-mono text-text-primary">
              {card.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────── SystemHealthBar ────────────────────── */

function SystemHealthBar({
  health,
}: {
  health: DashboardStats["system_health"];
}) {
  const systems = Object.entries(SYSTEM_LABELS);

  return (
    <div className="flex flex-wrap gap-3">
      {systems.map(([key, label]) => {
        const status = health[key] ?? "unknown";
        const style = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;

        return (
          <div
            key={key}
            className="flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-4 py-2.5"
          >
            <span
              className={cn(
                "w-2.5 h-2.5 rounded-full shrink-0",
                style.dot,
                style.pulse
              )}
            />
            <span className="text-sm text-text-primary font-medium">
              {label}
            </span>
            <span className={cn("text-xs", style.text)}>
              {STATUS_TEXT[status] ?? status}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────── ScoringTimeline ─────────────────────── */

interface ScoringRoundSummary {
  round_number: number;
  success_count: number;
  fail_count: number;
}

const TIMELINE_ROUNDS_LIMIT = 15;

function ScoringTimeline() {
  const [data, setData] = useState<
    { round: number; rate: number }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<ScoringRoundSummary[]>(
      `/scoring/rounds?limit=${TIMELINE_ROUNDS_LIMIT}`
    )
      .then((rounds) => {
        const mapped = [...rounds].reverse().map((r) => {
          const total = r.success_count + r.fail_count;
          const rate = total > 0 ? (r.success_count / total) * 100 : 0;
          return { round: r.round_number, rate: Math.round(rate * 10) / 10 };
        });
        setData(mapped);
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="bg-bg-secondary border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4 text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary">
          채점 성공률 추이
        </h2>
      </div>

      {loading ? (
        <div className="h-[200px] flex items-center justify-center">
          <div className="h-4 w-32 bg-bg-tertiary rounded animate-pulse" />
        </div>
      ) : data.length === 0 ? (
        <div className="h-[200px] flex items-center justify-center text-sm text-text-muted">
          라운드 데이터가 없습니다.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--color-chart-grid)"
            />
            <XAxis
              dataKey="round"
              tick={{ fill: "var(--color-chart-tick)", fontSize: 11 }}
              stroke="var(--color-chart-grid)"
              label={{
                value: "라운드",
                position: "insideBottomRight",
                offset: -5,
                fill: "var(--color-chart-tick)",
                fontSize: 10,
              }}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: "var(--color-chart-tick)", fontSize: 11 }}
              stroke="var(--color-chart-grid)"
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-chart-tooltip-bg)",
                border: "1px solid var(--color-chart-tooltip-border)",
                borderRadius: "8px",
                color: "var(--color-chart-tooltip-text)",
                fontSize: 12,
              }}
              labelFormatter={(label) => `라운드 ${label}`}
              formatter={(value: number) => [`${value}%`, "성공률"]}
            />
            <Line
              type="monotone"
              dataKey="rate"
              name="성공률"
              stroke="var(--color-status-ok)"
              strokeWidth={2}
              dot={{ r: 3, fill: "var(--color-status-ok)" }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/* ──────────────────── SkeletonLoader ──────────────────────── */

function SkeletonLoader() {
  return (
    <div className="space-y-6">
      {/* StatCard 스켈레톤 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-bg-secondary border border-border rounded-xl p-5 animate-pulse"
          >
            <div className="h-3 w-20 bg-bg-tertiary rounded mb-4" />
            <div className="h-8 w-16 bg-bg-tertiary rounded" />
          </div>
        ))}
      </div>

      {/* SystemHealth 스켈레톤 */}
      <div className="flex flex-wrap gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="bg-bg-secondary border border-border rounded-lg px-4 py-2.5 animate-pulse"
          >
            <div className="h-4 w-24 bg-bg-tertiary rounded" />
          </div>
        ))}
      </div>

      {/* 중간 패널 스켈레톤 */}
      <div className="bg-bg-secondary border border-border rounded-xl p-5 animate-pulse">
        <div className="h-4 w-32 bg-bg-tertiary rounded mb-4" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 mb-3 last:mb-0">
            <div className="h-3 w-16 bg-bg-tertiary rounded" />
            <div className="flex-1 h-2 bg-bg-tertiary rounded-full" />
            <div className="h-3 w-16 bg-bg-tertiary rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ──────────────────── DashboardPage ──────────────────────── */

const DEFAULT_STATS: DashboardStats = {
  active_teams: 0,
  scoring_round: 0,
  open_tickets: 0,
  current_vulnpack: 0,
  total_containers: 0,
  running_containers: 0,
  system_health: {},
};

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await apiFetch<any>("/dashboard/stats");

      // 백엔드는 system_health를 [{name, status, version}, ...] 배열로 반환
      // 프론트엔드는 Record<string, status> 딕셔너리로 사용
      const healthRecord: DashboardStats["system_health"] = {};
      if (Array.isArray(raw.system_health)) {
        for (const item of raw.system_health) {
          healthRecord[item.name] = item.status;
        }
      }

      setStats({ ...raw, system_health: healthRecord });
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStats]);

  if (loading) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">대시보드</h1>
        <SkeletonLoader />
      </div>
    );
  }

  if (error && stats === DEFAULT_STATS) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">대시보드</h1>
        <div className="bg-bg-secondary border border-border rounded-xl p-8 flex flex-col items-center gap-4">
          <p className="text-status-danger text-sm">
            데이터를 불러올 수 없습니다
          </p>
          <p className="text-text-muted text-xs">{error}</p>
          <button
            onClick={fetchStats}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            재시도
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">대시보드</h1>
        {error && (
          <span className="text-xs text-status-warning">
            최신 데이터 갱신 실패 -- 이전 데이터 표시 중
          </span>
        )}
      </div>

      <div className="space-y-6">
        {/* 1. 통계 카드 */}
        <StatCardGrid stats={stats} />

        {/* 2. 시스템 상태 */}
        <section>
          <h2 className="text-sm font-semibold text-text-primary mb-3">
            시스템 상태
          </h2>
          <SystemHealthBar health={stats.system_health} />
        </section>

        {/* 3. 채점 성공률 추이 */}
        <ScoringTimeline />

        {/* 4. 최근 운영 활동 (감사 로그 기반) */}
        <RecentActivity />
      </div>
    </div>
  );
}

// ── 최근 운영 활동 ──────────────────────────────────────
function RecentActivity() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ items: AuditLog[] }>("/audit/?page=1&limit=10")
      .then((d) => setLogs(d.items))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section>
      <h2 className="text-sm font-semibold text-text-primary mb-3">
        최근 운영 활동
      </h2>
      <div className="bg-bg-secondary border border-border rounded-xl p-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-6 bg-bg-tertiary rounded animate-pulse" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-center">
            <Activity className="w-6 h-6 text-text-muted mb-2" />
            <p className="text-xs text-text-muted">기록된 활동이 없습니다.</p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {logs.map((log) => (
              <li
                key={log.id}
                className="flex items-center justify-between text-xs py-1 border-b border-border last:border-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-text-primary truncate">
                    {log.actor_name}
                  </span>
                  <span className="font-mono text-accent truncate">
                    {log.action}
                  </span>
                </div>
                <span className="text-text-muted font-mono shrink-0 ml-2">
                  {new Date(log.created_at).toLocaleTimeString("ko-KR")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
