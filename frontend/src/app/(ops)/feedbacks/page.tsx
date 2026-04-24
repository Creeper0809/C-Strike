"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Star, BarChart3, Filter } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { FEEDBACK_CATEGORY_MAP } from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import type {
  FeedbackItem,
  FeedbackListResponse,
  FeedbackStatsResponse,
  CompetitionListItem,
  CompetitionListResponse,
} from "@/types/ops";

/* ────────────────────── 상수 ────────────────────── */

const PAGE_SIZE = 20;

const TABS = [
  { key: "list", label: "피드백 목록", icon: MessageSquare },
  { key: "stats", label: "통계", icon: BarChart3 },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체" },
  ...Object.entries(FEEDBACK_CATEGORY_MAP).map(([key, val]) => ({
    value: key,
    label: val.label,
  })),
];

const RATINGS = [1, 2, 3, 4, 5] as const;

/* ────────────────────── 유틸 ────────────────────── */

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/* ────────────────────── StarRating ────────────────────── */

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {RATINGS.map((i) => (
        <Star
          key={i}
          className={cn(
            "w-4 h-4",
            i <= rating
              ? "text-yellow-400 fill-yellow-400"
              : "text-text-muted",
          )}
        />
      ))}
    </span>
  );
}

/* ────────────────────── CategoryBadge ────────────────────── */

function CategoryBadge({ category }: { category: string }) {
  const config = FEEDBACK_CATEGORY_MAP[category];
  const label = config?.label ?? category;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-bg-tertiary text-text-secondary">
      {label}
    </span>
  );
}

/* ────────────────────── FeedbackCard ────────────────────── */

function FeedbackCard({ item }: { item: FeedbackItem }) {
  return (
    <div className="bg-bg-secondary rounded-xl border border-border p-5 space-y-3">
      {/* 상단: 유저 + 팀 + 별점 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-text-primary truncate">
            {item.discord_username ?? item.discord_user_id}
          </span>
          {item.team_name && (
            <span className="text-xs text-text-muted truncate">
              ({item.team_name})
            </span>
          )}
        </div>
        <StarRating rating={item.rating} />
      </div>

      {/* 중간: 내용 */}
      <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
        {item.content}
      </p>

      {/* 하단: 카테고리 + 시간 */}
      <div className="flex items-center justify-between">
        <CategoryBadge category={item.category} />
        <span className="text-xs text-text-muted font-mono">
          {formatDateTime(item.created_at)}
        </span>
      </div>
    </div>
  );
}

/* ────────────────────── 목록 탭 ────────────────────── */

function FeedbackListTab({ competitionId }: { competitionId: string }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  /* 필터 상태 */
  const [category, setCategory] = useState("");
  const [ratingMin, setRatingMin] = useState<number | null>(null);
  const [ratingMax, setRatingMax] = useState<number | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(PAGE_SIZE),
      });
      if (category) params.set("category", category);
      if (ratingMin !== null) params.set("rating_min", String(ratingMin));
      if (ratingMax !== null) params.set("rating_max", String(ratingMax));

      const res = await apiFetch<FeedbackListResponse>(
        `/v1/competitions/${competitionId}/feedbacks/?${params.toString()}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [competitionId, page, category, ratingMin, ratingMax]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  /* 별점 토글: 클릭 시 min/max 를 하나의 값으로 설정, 같은 값 재클릭 시 해제 */
  function handleRatingToggle(r: number) {
    if (ratingMin === r && ratingMax === r) {
      setRatingMin(null);
      setRatingMax(null);
    } else {
      setRatingMin(r);
      setRatingMax(r);
    }
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <div className="space-y-5">
      {/* 필터 영역 */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-text-muted" />
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent transition-colors"
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted mr-1">별점</span>
          {RATINGS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => handleRatingToggle(r)}
              className={cn(
                "flex items-center gap-0.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                ratingMin === r && ratingMax === r
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-bg-tertiary text-text-secondary hover:text-text-primary",
              )}
            >
              {r}
              <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
            </button>
          ))}
        </div>

        <span className="text-xs text-text-muted ml-auto">
          총 {total}건
        </span>
      </div>

      {/* 로딩 */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
        </div>
      )}

      {/* 빈 상태 */}
      {!loading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-text-muted">
          <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">등록된 피드백이 없습니다.</p>
        </div>
      )}

      {/* 카드 목록 */}
      {!loading && items.length > 0 && (
        <div className="grid gap-4">
          {items.map((item) => (
            <FeedbackCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {/* 페이지네이션 */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => setPage((p) => p - 1)}
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
            onClick={() => setPage((p) => p + 1)}
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
  );
}

/* ────────────────────── 통계 탭 ────────────────────── */

function FeedbackStatsTab({ competitionId }: { competitionId: string }) {
  const [stats, setStats] = useState<FeedbackStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await apiFetch<FeedbackStatsResponse>(
          `/v1/competitions/${competitionId}/feedbacks/stats`,
        );
        if (!cancelled) setStats(data);
      } catch {
        if (!cancelled) setStats(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [competitionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-text-muted">
        <BarChart3 className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">통계 데이터를 불러올 수 없습니다.</p>
      </div>
    );
  }

  /* 별점 분포 바 차트에서 최대값 */
  const distEntries = RATINGS.map((r) => ({
    rating: r,
    count: stats.rating_distribution[String(r)] ?? 0,
  }));
  const maxCount = Math.max(...distEntries.map((d) => d.count), 1);

  /* 카테고리별 집계 */
  const categoryEntries = Object.entries(stats.category_breakdown).map(
    ([key, val]) => ({
      key,
      label: FEEDBACK_CATEGORY_MAP[key]?.label ?? key,
      count: val.count,
      avgRating: val.average_rating,
    }),
  );

  return (
    <div className="space-y-6">
      {/* 상단 요약 카드 3개 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* 전체 피드백 수 */}
        <div className="bg-bg-secondary rounded-xl border border-border p-5">
          <p className="text-xs text-text-muted mb-1">전체 피드백</p>
          <p className="text-3xl font-bold font-mono text-text-primary">
            {stats.total_feedbacks}
          </p>
        </div>

        {/* 평균 별점 */}
        <div className="bg-bg-secondary rounded-xl border border-border p-5">
          <p className="text-xs text-text-muted mb-1">평균 별점</p>
          <div className="flex items-center gap-2">
            <p className="text-3xl font-bold font-mono text-text-primary">
              {stats.average_rating.toFixed(1)}
            </p>
            <Star className="w-6 h-6 text-yellow-400 fill-yellow-400" />
          </div>
        </div>

        {/* 참여율 */}
        <div className="bg-bg-secondary rounded-xl border border-border p-5">
          <p className="text-xs text-text-muted mb-1">참여율</p>
          <p className="text-3xl font-bold font-mono text-text-primary">
            {(stats.participation_rate * 100).toFixed(1)}%
          </p>
        </div>
      </div>

      {/* 별점 분포 바 차트 */}
      <div className="bg-bg-secondary rounded-xl border border-border p-5 space-y-4">
        <h3 className="text-sm font-medium text-text-primary">별점 분포</h3>
        <div className="space-y-3">
          {[...distEntries].reverse().map((d) => (
            <div key={d.rating} className="flex items-center gap-3">
              <span className="flex items-center gap-1 w-12 shrink-0 text-sm text-text-secondary">
                {d.rating}
                <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />
              </span>
              <div className="flex-1 bg-bg-tertiary rounded-full h-3 overflow-hidden">
                <div
                  className="bg-accent rounded-full h-3 transition-all duration-500"
                  style={{ width: `${(d.count / maxCount) * 100}%` }}
                />
              </div>
              <span className="w-10 text-right text-sm font-mono text-text-secondary">
                {d.count}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 카테고리별 평균 */}
      <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-medium text-text-primary">
            카테고리별 평균
          </h3>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-bg-tertiary">
              <th className="px-5 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                카테고리
              </th>
              <th className="px-5 py-3 text-right text-xs font-medium text-text-secondary uppercase tracking-wider">
                건수
              </th>
              <th className="px-5 py-3 text-right text-xs font-medium text-text-secondary uppercase tracking-wider">
                평균 별점
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {categoryEntries.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-5 py-8 text-center text-sm text-text-muted"
                >
                  데이터 없음
                </td>
              </tr>
            )}
            {categoryEntries.map((entry) => (
              <tr
                key={entry.key}
                className="transition-colors hover:bg-bg-tertiary/50"
              >
                <td className="px-5 py-3 text-sm text-text-primary">
                  {entry.label}
                </td>
                <td className="px-5 py-3 text-sm text-text-secondary text-right font-mono">
                  {entry.count}
                </td>
                <td className="px-5 py-3 text-right">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-sm font-mono text-text-primary">
                      {entry.avgRating.toFixed(1)}
                    </span>
                    <StarRating rating={Math.round(entry.avgRating)} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ────────────────────── 메인 페이지 ────────────────────── */

export default function FeedbacksPage() {
  const [tab, setTab] = useState<TabKey>("list");

  /* 대회 목록 → 첫 대회 자동 선택 */
  const [competitions, setCompetitions] = useState<CompetitionListItem[]>([]);
  const [competitionId, setCompetitionId] = useState<string | null>(null);
  const [initLoading, setInitLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch<CompetitionListResponse>(
          "/v1/competitions/?page=1&size=100",
        );
        setCompetitions(res.items);
        if (res.items.length > 0) {
          setCompetitionId(res.items[0].id);
        }
      } catch {
        setCompetitions([]);
      } finally {
        setInitLoading(false);
      }
    })();
  }, []);

  /* 초기 로딩 */
  if (initLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="피드백 관리" />
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
        </div>
      </div>
    );
  }

  /* 대회가 하나도 없을 때 */
  if (competitions.length === 0 || !competitionId) {
    return (
      <div className="space-y-6">
        <PageHeader title="피드백 관리" />
        <div className="flex flex-col items-center justify-center py-24 text-text-muted">
          <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">대회가 등록되지 않았습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <PageHeader
        title="피드백 관리"
        actions={
          competitions.length > 1 ? (
            <select
              value={competitionId}
              onChange={(e) => setCompetitionId(e.target.value)}
              className="px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent transition-colors"
            >
              {competitions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      {/* 탭 바 */}
      <div className="flex items-center border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-secondary",
              )}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* 탭 콘텐츠 */}
      {tab === "list" && <FeedbackListTab competitionId={competitionId} />}
      {tab === "stats" && <FeedbackStatsTab competitionId={competitionId} />}
    </div>
  );
}
