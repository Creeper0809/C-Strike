"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Loader2, Trophy, Clock, Download,
  Medal, Swords, Shield, Activity,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/ui/PageHeader";
import type {
  CompetitionResultsResponse,
  TimelineResponse,
  TimelineEvent,
} from "@/types/ops";

/* ── 탭 정의 ── */
type TabKey = "results" | "timeline" | "export";

const TABS: { key: TabKey; label: string }[] = [
  { key: "results", label: "결과" },
  { key: "timeline", label: "타임라인" },
  { key: "export", label: "내보내기" },
];

/* ── 타임라인 이벤트 설정 ── */
const EVENT_CONFIG: Record<string, {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}> = {
  competition_started: { icon: Trophy, color: "text-status-ok" },
  round_completed:     { icon: Activity, color: "text-status-info" },
  flag_captured:       { icon: Swords, color: "text-status-warning" },
  emergency_pause:     { icon: Shield, color: "text-status-danger" },
};

/* ── 내보내기 파일 목록 ── */
const EXPORT_FILES = [
  { name: "results.json", desc: "최종 순위 및 통계" },
  { name: "rounds.csv", desc: "라운드별 결과" },
  { name: "scores.csv", desc: "팀별 점수 이력" },
  { name: "flags.csv", desc: "플래그 생성 기록" },
  { name: "submissions.csv", desc: "플래그 제출 기록" },
  { name: "sla_checks.csv", desc: "SLA 점검 결과" },
  { name: "audit_logs.csv", desc: "감사 로그" },
];

/* ── 유틸리티 ── */
function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEventDetails(event: TimelineEvent): string {
  const d = event.details;
  switch (event.type) {
    case "competition_started":
      return "대회가 시작되었습니다";
    case "round_completed":
      return `라운드 ${d.round ?? "?"} 완료 — 1위: ${d.top_team ?? "N/A"}`;
    case "flag_captured":
      return `${d.attacker ?? "?"} \u2192 ${d.victim ?? "?"} (${d.service ?? "?"})`;
    case "emergency_pause":
      return `비상 중단: ${d.reason ?? "사유 없음"}`;
    default:
      return JSON.stringify(d);
  }
}

function slaColor(pct: number): string {
  if (pct >= 95) return "text-status-ok";
  if (pct >= 80) return "text-status-warning";
  return "text-status-danger";
}

function medalColor(rank: number): string {
  if (rank === 1) return "text-yellow-400";
  if (rank === 2) return "text-gray-300";
  if (rank === 3) return "text-amber-600";
  return "text-text-muted";
}

/* ── 개요 카드 컴포넌트 ── */
function StatCard({ icon: Icon, label, value }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-bg-secondary rounded-xl p-4 border border-border">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-text-muted" />
        <span className="text-xs text-text-muted">{label}</span>
      </div>
      <p className="text-lg font-semibold font-mono text-text-primary">{value}</p>
    </div>
  );
}

/* ── 메인 페이지 ── */
export default function CompetitionResultsPage() {
  const params = useParams();
  const router = useRouter();
  const competitionId = params.id as string;

  const [activeTab, setActiveTab] = useState<TabKey>("results");
  const [results, setResults] = useState<CompetitionResultsResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [isLoadingResults, setIsLoadingResults] = useState(true);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  /* 결과 데이터 조회 */
  const fetchResults = useCallback(async () => {
    setIsLoadingResults(true);
    setError(null);
    try {
      const data = await apiFetch<CompetitionResultsResponse>(
        `/v1/competition-results/results?competition_id=${competitionId}`,
      );
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "결과 데이터를 불러오지 못했습니다.");
    } finally {
      setIsLoadingResults(false);
    }
  }, [competitionId]);

  /* 타임라인 데이터 조회 */
  const fetchTimeline = useCallback(async () => {
    setIsLoadingTimeline(true);
    setError(null);
    try {
      const data = await apiFetch<TimelineResponse>(
        `/v1/competition-results/timeline?competition_id=${competitionId}`,
      );
      setTimeline(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "타임라인을 불러오지 못했습니다.");
    } finally {
      setIsLoadingTimeline(false);
    }
  }, [competitionId]);

  /* 초기 로드 */
  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  /* 타임라인 탭 진입 시 로드 */
  useEffect(() => {
    if (activeTab === "timeline" && !timeline) {
      fetchTimeline();
    }
  }, [activeTab, timeline, fetchTimeline]);

  /* ZIP 내보내기 */
  function handleExport() {
    setIsExporting(true);
    window.location.href = `/api/v1/competition-results/export?competition_id=${competitionId}`;
    // 다운로드 시작 후 잠시 뒤 버튼 복원
    setTimeout(() => setIsExporting(false), 3000);
  }

  /* ── 로딩 상태 ── */
  if (isLoadingResults) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  if (!results) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.push(`/competitions/${competitionId}`)}
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> 대회 상세로
        </button>
        <div className="text-center py-20 text-status-danger">
          {error || "결과 데이터를 찾을 수 없습니다."}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 뒤로가기 */}
      <button
        onClick={() => router.push(`/competitions/${competitionId}`)}
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> 대회 상세로
      </button>

      <PageHeader
        title={`${results.competition_name} — 결과`}
        description="대회 결과 리포트, 타임라인 리플레이, 데이터 내보내기"
      />

      {/* 에러 배너 */}
      {error && (
        <div className="rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            닫기
          </button>
        </div>
      )}

      {/* 탭 네비게이션 */}
      <nav className="flex gap-1 bg-bg-secondary rounded-lg p-1 border border-border w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-4 py-2 text-sm rounded-md transition-colors",
              activeTab === tab.key
                ? "bg-bg-tertiary text-text-primary font-medium"
                : "text-text-muted hover:text-text-secondary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── 결과 탭 ── */}
      {activeTab === "results" && (
        <div className="space-y-6">
          {/* 개요 카드 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Clock} label="대회 시간" value={`${results.duration_hours}시간`} />
            <StatCard icon={Activity} label="총 라운드" value={String(results.total_rounds)} />
            <StatCard icon={Trophy} label="참가 팀" value={`${results.total_teams}팀`} />
            <StatCard
              icon={Swords}
              label="정답 플래그"
              value={`${results.total_correct_flags} / ${results.total_flag_submissions}`}
            />
          </div>

          {/* 최종 순위 테이블 */}
          <section className="bg-bg-secondary rounded-xl border border-border">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">최종 순위</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-text-muted text-left">
                    <th className="px-5 py-3 w-16">순위</th>
                    <th className="px-5 py-3">팀명</th>
                    <th className="px-5 py-3 text-right">총점</th>
                    <th className="px-5 py-3 text-right">공격</th>
                    <th className="px-5 py-3 text-right">방어</th>
                    <th className="px-5 py-3 text-right">SLA</th>
                    <th className="px-5 py-3 text-right">획득</th>
                    <th className="px-5 py-3 text-right">피탈</th>
                  </tr>
                </thead>
                <tbody>
                  {results.rankings.map((r) => (
                    <tr
                      key={r.team_id}
                      className="border-b border-border/50 hover:bg-bg-tertiary/50 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          {r.rank <= 3 ? (
                            <Medal className={cn("w-4 h-4", medalColor(r.rank))} />
                          ) : (
                            <span className="w-4 text-center font-mono text-text-muted">
                              {r.rank}
                            </span>
                          )}
                          {r.rank <= 3 && (
                            <span className={cn("font-mono font-semibold", medalColor(r.rank))}>
                              {r.rank}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-text-primary font-medium">{r.team_name}</td>
                      <td className="px-5 py-3 text-right font-mono text-text-primary">
                        {r.total_score.toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-text-secondary">
                        {r.attack_score.toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-text-secondary">
                        {r.defense_score.toLocaleString()}
                      </td>
                      <td className={cn(
                        "px-5 py-3 text-right font-mono",
                        slaColor(r.sla_percentage),
                      )}>
                        {r.sla_percentage.toFixed(1)}%
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-text-secondary">
                        {r.flags_captured}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-text-secondary">
                        {r.flags_lost}
                      </td>
                    </tr>
                  ))}
                  {results.rankings.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-5 py-10 text-center text-text-muted">
                        순위 데이터가 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* 서비스별 통계 테이블 */}
          <section className="bg-bg-secondary rounded-xl border border-border">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-text-primary">서비스별 통계</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-text-muted text-left">
                    <th className="px-5 py-3">서비스명</th>
                    <th className="px-5 py-3 text-right">총 탈취 플래그</th>
                    <th className="px-5 py-3 text-right">평균 SLA</th>
                    <th className="px-5 py-3">최다 공격받은 팀</th>
                  </tr>
                </thead>
                <tbody>
                  {results.service_stats.map((s) => (
                    <tr
                      key={s.service_id}
                      className="border-b border-border/50 hover:bg-bg-tertiary/50 transition-colors"
                    >
                      <td className="px-5 py-3 text-text-primary font-medium">{s.service_name}</td>
                      <td className="px-5 py-3 text-right font-mono text-text-secondary">
                        {s.total_flags_captured}
                      </td>
                      <td className={cn(
                        "px-5 py-3 text-right font-mono",
                        slaColor(s.average_sla),
                      )}>
                        {s.average_sla.toFixed(1)}%
                      </td>
                      <td className="px-5 py-3 text-text-secondary">
                        {s.most_attacked_team || "-"}
                      </td>
                    </tr>
                  ))}
                  {results.service_stats.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-10 text-center text-text-muted">
                        서비스 통계가 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* ── 타임라인 탭 ── */}
      {activeTab === "timeline" && (
        <div className="space-y-4">
          {isLoadingTimeline ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
            </div>
          ) : !timeline || timeline.events.length === 0 ? (
            <div className="text-center py-20 text-text-muted">
              타임라인 이벤트가 없습니다.
            </div>
          ) : (
            <section className="bg-bg-secondary rounded-xl border border-border p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-text-primary">
                  이벤트 타임라인
                </h2>
                <span className="text-xs text-text-muted">
                  총 {timeline.events.length}개 이벤트 | {timeline.total_rounds} 라운드
                </span>
              </div>
              <div className="relative">
                {/* 세로선 */}
                <div className="absolute left-[140px] top-0 bottom-0 w-px bg-border" />

                <div className="space-y-0">
                  {timeline.events.map((event, idx) => {
                    const config = EVENT_CONFIG[event.type] ?? {
                      icon: Activity,
                      color: "text-text-muted",
                    };
                    const Icon = config.icon;

                    return (
                      <div key={idx} className="flex items-start gap-4 py-3 group">
                        {/* 타임스탬프 */}
                        <div className="w-[124px] shrink-0 text-right">
                          <span className="text-xs font-mono text-text-muted">
                            {formatTimestamp(event.timestamp)}
                          </span>
                        </div>

                        {/* 아이콘 (세로선 위) */}
                        <div className="relative z-10 shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-bg-tertiary border border-border group-hover:border-accent/50 transition-colors">
                          <Icon className={cn("w-4 h-4", config.color)} />
                        </div>

                        {/* 내용 */}
                        <div className="flex-1 min-w-0 pt-1">
                          <p className="text-sm text-text-primary">
                            {formatEventDetails(event)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── 내보내기 탭 ── */}
      {activeTab === "export" && (
        <div className="space-y-6">
          <section className="bg-bg-secondary rounded-xl border border-border p-6">
            <h2 className="text-sm font-semibold text-text-primary mb-4">
              ZIP 데이터 내보내기
            </h2>
            <p className="text-sm text-text-secondary mb-6">
              대회의 전체 데이터를 ZIP 파일로 내려받습니다. 다음 파일이 포함됩니다.
            </p>

            {/* 포함 파일 목록 */}
            <div className="bg-bg-tertiary rounded-lg border border-border divide-y divide-border mb-6">
              {EXPORT_FILES.map((f) => (
                <div key={f.name} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-mono text-text-primary">{f.name}</span>
                  <span className="text-xs text-text-muted">{f.desc}</span>
                </div>
              ))}
            </div>

            {/* 다운로드 버튼 */}
            <button
              onClick={handleExport}
              disabled={isExporting}
              className={cn(
                "w-full inline-flex items-center justify-center gap-2 px-6 py-4",
                "text-sm font-medium rounded-xl transition-colors",
                "bg-accent text-white hover:bg-accent/80 disabled:opacity-50",
              )}
            >
              {isExporting ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Download className="w-5 h-5" />
              )}
              {isExporting ? "다운로드 준비 중..." : "ZIP 파일 다운로드"}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
