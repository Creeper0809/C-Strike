"use client";

import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  X,
  Send,
  User,
  MessageSquare,
  Loader2,
  Star,
  BarChart3,
  Filter,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  TICKET_STATUS_MAP,
  PRIORITY_MAP,
  STATUS_COLORS,
  FEEDBACK_CATEGORY_MAP,
} from "@/lib/constants";
import type {
  Ticket,
  FeedbackItem,
  FeedbackListResponse,
  FeedbackStatsResponse,
  CompetitionListItem,
  CompetitionListResponse,
} from "@/types/ops";

/* ────────────────────── Types ────────────────────── */

interface TicketMessage {
  id: string;
  author_name: string;
  content: string;
  sent_to_discord: boolean;
  created_at: string;
}

interface TicketDetail extends Ticket {
  messages: TicketMessage[];
}

interface TicketListResponse {
  items: Ticket[];
  total: number;
}

type MainTabKey = "tickets" | "feedback";
type FeedbackTabKey = "list" | "stats";

/* ────────────────────── Constants ────────────────────── */

const KANBAN_COLUMNS: { key: string; label: string }[] = [
  { key: "open", label: "열림" },
  { key: "in_progress", label: "처리 중" },
  { key: "resolved", label: "해결됨" },
  { key: "rejected", label: "반려됨" },
  { key: "closed", label: "보관됨" },
];

const TYPE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  dispute: { label: "이의제기", color: "text-status-info", bg: "bg-status-info/10" },
  violation: { label: "규정위반", color: "text-status-danger", bg: "bg-status-danger/10" },
};

const MAIN_TABS: { key: MainTabKey; label: string; icon: typeof MessageSquare }[] = [
  { key: "tickets", label: "문의 티켓", icon: MessageSquare },
  { key: "feedback", label: "사후 피드백", icon: Star },
];

const FEEDBACK_TABS = [
  { key: "list", label: "피드백 목록", icon: MessageSquare },
  { key: "stats", label: "통계", icon: BarChart3 },
] as const;

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "전체" },
  ...Object.entries(FEEDBACK_CATEGORY_MAP).map(([key, val]) => ({
    value: key,
    label: val.label,
  })),
];

const RATINGS = [1, 2, 3, 4, 5] as const;
const FEEDBACK_PAGE_SIZE = 20;

/* ────────────────────── Helpers ────────────────────── */

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function formatRelative(value: string): string {
  try {
    const diff = Date.now() - new Date(value).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "방금";
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    return `${days}일 전`;
  } catch {
    return value;
  }
}

/* ────────────────────── Ticket Badges ────────────────────── */

function PriorityBadge({ priority }: { priority: string }) {
  const config = PRIORITY_MAP[priority];
  if (!config) return null;

  const colorClass = STATUS_COLORS[config.color] ?? "text-text-muted";

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium",
        colorClass,
        config.color === "danger" && "bg-status-danger/10",
        config.color === "warning" && "bg-status-warning/10",
        config.color === "neutral" && "bg-bg-tertiary",
      )}
    >
      {config.label}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const config = TYPE_LABELS[type];
  if (!config) return <span className="text-xs text-text-muted">{type}</span>;

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium",
        config.color,
        config.bg,
      )}
    >
      {config.label}
    </span>
  );
}

/* ────────────────────── Feedback Helpers ────────────────────── */

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

function CategoryBadge({ category }: { category: string }) {
  const config = FEEDBACK_CATEGORY_MAP[category];
  const label = config?.label ?? category;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-bg-tertiary text-text-secondary">
      {label}
    </span>
  );
}

/* ────────────────────── TicketCard ────────────────────── */

function TicketCard({
  ticket,
  onClick,
}: {
  ticket: Ticket;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-bg-secondary border border-border rounded-lg p-3 hover:border-accent/50 transition-colors space-y-2"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-text-muted">
          {ticket.ticket_number}
        </span>
        <PriorityBadge priority={ticket.priority} />
      </div>

      <p className="text-sm font-medium text-text-primary truncate">
        {ticket.title}
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <TypeBadge type={ticket.type} />
        {ticket.team_name && (
          <span className="text-xs text-text-muted">{ticket.team_name}</span>
        )}
        {ticket.assigned_to && (
          <span className="flex items-center gap-1 text-xs text-text-secondary ml-auto">
            <User className="w-3 h-3" />
            {ticket.assigned_to_name ?? ticket.assigned_to}
          </span>
        )}
      </div>

      <p className="text-xs text-text-muted">{formatRelative(ticket.created_at)}</p>
    </button>
  );
}

/* ────────────────────── KanbanColumn ────────────────────── */

function KanbanColumn({
  columnKey,
  label,
  tickets,
  onTicketClick,
}: {
  columnKey: string;
  label: string;
  tickets: Ticket[];
  onTicketClick: (ticket: Ticket) => void;
}) {
  const statusConfig = TICKET_STATUS_MAP[columnKey];
  const colorClass = statusConfig
    ? STATUS_COLORS[statusConfig.color]
    : "text-text-muted";

  return (
    <div className="flex flex-col min-w-[260px] flex-1">
      <div className="flex items-center gap-2 mb-3 px-1">
        <h3 className={cn("text-sm font-medium", colorClass)}>{label}</h3>
        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-medium bg-bg-tertiary text-text-secondary">
          {tickets.length}
        </span>
      </div>

      <div className="flex-1 space-y-2 min-h-[200px]">
        {tickets.map((ticket) => (
          <TicketCard
            key={ticket.id}
            ticket={ticket}
            onClick={() => onTicketClick(ticket)}
          />
        ))}
        {tickets.length === 0 && (
          <div className="flex items-center justify-center h-24 rounded-lg border border-dashed border-border">
            <p className="text-xs text-text-muted">티켓 없음</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────── FeedbackCard ────────────────────── */

function FeedbackCard({ item }: { item: FeedbackItem }) {
  return (
    <div className="bg-bg-secondary rounded-xl border border-border p-5 space-y-3">
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

      <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
        {item.content}
      </p>

      <div className="flex items-center justify-between">
        <CategoryBadge category={item.category} />
        <span className="text-xs text-text-muted font-mono">
          {formatDateTime(item.created_at)}
        </span>
      </div>
    </div>
  );
}

/* ────────────────────── FeedbackListTab ────────────────────── */

function FeedbackListTab({ competitionId }: { competitionId: string }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("");
  const [ratingMin, setRatingMin] = useState<number | null>(null);
  const [ratingMax, setRatingMax] = useState<number | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        size: String(FEEDBACK_PAGE_SIZE),
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
  }, [category, competitionId, page, ratingMax, ratingMin]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

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

  const totalPages = Math.max(1, Math.ceil(total / FEEDBACK_PAGE_SIZE));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <div className="space-y-5">
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

        <span className="text-xs text-text-muted ml-auto">총 {total}건</span>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-text-muted">
          <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">등록된 피드백이 없습니다.</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="grid gap-4">
          {items.map((item) => (
            <FeedbackCard key={item.id} item={item} />
          ))}
        </div>
      )}

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

/* ────────────────────── FeedbackStatsTab ────────────────────── */

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

  const distEntries = RATINGS.map((r) => ({
    rating: r,
    count: stats.rating_distribution[String(r)] ?? 0,
  }));
  const maxCount = Math.max(...distEntries.map((d) => d.count), 1);

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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-bg-secondary rounded-xl border border-border p-5">
          <p className="text-xs text-text-muted mb-1">전체 피드백</p>
          <p className="text-3xl font-bold font-mono text-text-primary">
            {stats.total_feedbacks}
          </p>
        </div>

        <div className="bg-bg-secondary rounded-xl border border-border p-5">
          <p className="text-xs text-text-muted mb-1">평균 별점</p>
          <div className="flex items-center gap-2">
            <p className="text-3xl font-bold font-mono text-text-primary">
              {stats.average_rating.toFixed(1)}
            </p>
            <Star className="w-6 h-6 text-yellow-400 fill-yellow-400" />
          </div>
        </div>

        <div className="bg-bg-secondary rounded-xl border border-border p-5">
          <p className="text-xs text-text-muted mb-1">참여율</p>
          <p className="text-3xl font-bold font-mono text-text-primary">
            {stats.participation_rate.toFixed(1)}%
          </p>
        </div>
      </div>

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

/* ────────────────────── FeedbackPanel ────────────────────── */

function FeedbackPanel() {
  const [tab, setTab] = useState<FeedbackTabKey>("list");
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
        const running = res.items.find((item) => item.status === "running");
        const effective = running ?? res.items[0] ?? null;
        setCompetitionId(effective?.id ?? null);
      } catch {
        setCompetitions([]);
        setCompetitionId(null);
      } finally {
        setInitLoading(false);
      }
    })();
  }, []);

  if (initLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
      </div>
    );
  }

  if (competitions.length === 0 || !competitionId) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-text-muted">
        <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">대회가 등록되지 않았습니다.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          {FEEDBACK_TABS.map((item) => {
            const Icon = item.icon;
            const isActive = tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors",
                  isActive
                    ? "bg-accent/10 text-accent"
                    : "text-text-muted hover:text-text-secondary hover:bg-bg-tertiary",
                )}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        {competitions.length > 1 && (
          <select
            value={competitionId}
            onChange={(e) => setCompetitionId(e.target.value)}
            className="px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent transition-colors"
          >
            {competitions.map((competition) => (
              <option key={competition.id} value={competition.id}>
                {competition.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {tab === "list" && <FeedbackListTab competitionId={competitionId} />}
      {tab === "stats" && <FeedbackStatsTab competitionId={competitionId} />}
    </div>
  );
}

/* ────────────────────── TicketDetailPanel ────────────────────── */

function TicketDetailPanel({
  ticketId,
  onClose,
  onUpdated,
}: {
  ticketId: string;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [newStatus, setNewStatus] = useState("");
  const [newPriority, setNewPriority] = useState("");
  const [statusSaving, setStatusSaving] = useState(false);

  const [responseText, setResponseText] = useState("");
  const [sendToDiscord, setSendToDiscord] = useState(false);
  const [responseSending, setResponseSending] = useState(false);

  const [error, setError] = useState<string | null>(null);

  async function fetchDetail() {
    setLoading(true);
    try {
      const data = await apiFetch<TicketDetail>(`/tickets/${ticketId}`);
      setDetail(data);
      setNewStatus(data.status);
      setNewPriority(data.priority);
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "티켓 정보를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleStatusChange() {
    if (!detail) return;
    if (newStatus === detail.status && newPriority === detail.priority) return;

    setStatusSaving(true);
    try {
      await apiFetch(`/tickets/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: newStatus,
          priority: newPriority,
        }),
      });
      await fetchDetail();
      onUpdated();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "변경에 실패했습니다.";
      setError(message);
    } finally {
      setStatusSaving(false);
    }
  }

  async function handleSendResponse() {
    const trimmed = responseText.trim();
    if (!trimmed) return;

    setResponseSending(true);
    try {
      await apiFetch(`/tickets/${ticketId}/respond`, {
        method: "POST",
        body: JSON.stringify({
          content: trimmed,
          send_to_discord: sendToDiscord,
        }),
      });
      setResponseText("");
      setSendToDiscord(false);
      await fetchDetail();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "응답 전송에 실패했습니다.";
      setError(message);
    } finally {
      setResponseSending(false);
    }
  }

  useEffect(() => {
    fetchDetail();
  }, [ticketId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="fixed right-0 top-0 z-50 h-full w-[420px] bg-bg-elevated border-l border-border p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-5 w-40 bg-bg-tertiary rounded" />
          <div className="h-4 w-full bg-bg-tertiary rounded" />
          <div className="h-4 w-3/4 bg-bg-tertiary rounded" />
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="fixed right-0 top-0 z-50 h-full w-[420px] bg-bg-elevated border-l border-border p-4">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-status-danger">{error ?? "불러올 수 없습니다."}</p>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  const statusConfig = TICKET_STATUS_MAP[detail.status];
  const hasChanges = newStatus !== detail.status || newPriority !== detail.priority;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      <div className="fixed right-0 top-0 z-50 h-full w-[420px] bg-bg-elevated border-l border-border overflow-y-auto">
        <div className="sticky top-0 z-10 bg-bg-elevated border-b border-border px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-xs text-text-muted shrink-0">
              {detail.ticket_number}
            </span>
            {statusConfig && (
              <span
                className={cn(
                  "px-2 py-0.5 rounded text-xs font-medium",
                  STATUS_COLORS[statusConfig.color],
                  statusConfig.color === "danger" && "bg-status-danger/10",
                  statusConfig.color === "warning" && "bg-status-warning/10",
                  statusConfig.color === "ok" && "bg-status-ok/10",
                  statusConfig.color === "info" && "bg-status-info/10",
                  statusConfig.color === "neutral" && "bg-bg-tertiary",
                )}
              >
                {statusConfig.label}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-text-primary">
              {detail.title}
            </h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              {detail.description}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-text-muted block mb-1">유형</span>
              <TypeBadge type={detail.type} />
            </div>
            <div>
              <span className="text-text-muted block mb-1">우선순위</span>
              <PriorityBadge priority={detail.priority} />
            </div>
            <div>
              <span className="text-text-muted block mb-1">팀</span>
              <span className="text-text-primary">{detail.team_name ?? "-"}</span>
            </div>
            <div>
              <span className="text-text-muted block mb-1">담당자</span>
              <span className="text-text-primary">
                {detail.assigned_to_name ?? detail.assigned_to ?? "-"}
              </span>
            </div>
            <div>
              <span className="text-text-muted block mb-1">생성일</span>
              <span className="text-text-primary font-mono">
                {formatDateTime(detail.created_at)}
              </span>
            </div>
            {detail.discord_ticket_id && (
              <div>
                <span className="text-text-muted block mb-1">Discord</span>
                <span className="text-text-primary font-mono text-xs">
                  {detail.discord_ticket_id}
                </span>
              </div>
            )}
          </div>

          <div className="bg-bg-secondary border border-border rounded-lg p-3 space-y-3">
            <h4 className="text-xs font-medium text-text-secondary">상태 변경</h4>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-text-muted mb-1 block">상태</span>
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
                >
                  {Object.entries(TICKET_STATUS_MAP).map(([key, val]) => (
                    <option key={key} value={key}>
                      {val.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-text-muted mb-1 block">우선순위</span>
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
                >
                  {Object.entries(PRIORITY_MAP).map(([key, val]) => (
                    <option key={key} value={key}>
                      {val.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {hasChanges && (
              <button
                type="button"
                onClick={handleStatusChange}
                disabled={statusSaving}
                className={cn(
                  "w-full px-3 py-1.5 text-xs font-medium rounded-lg bg-accent hover:bg-accent-hover text-white transition-colors",
                  statusSaving && "opacity-50 cursor-not-allowed",
                )}
              >
                {statusSaving ? "저장 중..." : "변경 저장"}
              </button>
            )}
          </div>

          {error && <p className="text-xs text-status-danger">{error}</p>}

          <div className="space-y-3">
            <h4 className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" />
              대화 ({detail.messages.length})
            </h4>

            {detail.messages.length === 0 ? (
              <p className="text-xs text-text-muted text-center py-4">
                아직 메시지가 없습니다.
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {detail.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className="bg-bg-secondary border border-border rounded-lg p-3 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-text-primary flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {msg.author_name}
                      </span>
                      <span className="text-xs text-text-muted font-mono">
                        {formatDateTime(msg.created_at)}
                      </span>
                    </div>
                    <p className="text-sm text-text-secondary leading-relaxed">
                      {msg.content}
                    </p>
                    {msg.sent_to_discord && (
                      <span className="text-xs text-status-info">Discord 전송됨</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <textarea
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              placeholder="응답을 입력하세요..."
              rows={3}
              className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors resize-none"
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendToDiscord}
                  onChange={(e) => setSendToDiscord(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-border bg-bg-secondary text-accent focus:ring-accent"
                />
                <span className="text-xs text-text-secondary">Discord 전송</span>
              </label>
              <button
                type="button"
                onClick={handleSendResponse}
                disabled={!responseText.trim() || responseSending}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white transition-colors",
                  responseText.trim()
                    ? "hover:bg-accent-hover"
                    : "opacity-50 cursor-not-allowed",
                  responseSending && "opacity-50 cursor-not-allowed",
                )}
              >
                <Send className="w-3.5 h-3.5" />
                {responseSending ? "전송 중..." : "전송"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ────────────────────── TicketsPage ────────────────────── */

export default function TicketsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedMainTab: MainTabKey =
    searchParams.get("tab") === "feedback" ? "feedback" : "tickets";

  const [mainTab, setMainTab] = useState<MainTabKey>(requestedMainTab);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  useEffect(() => {
    setMainTab(requestedMainTab);
  }, [requestedMainTab]);

  const updateMainTab = useCallback(
    (nextTab: MainTabKey) => {
      setMainTab(nextTab);
      const params = new URLSearchParams(searchParams.toString());
      if (nextTab === "feedback") {
        params.set("tab", "feedback");
      } else {
        params.delete("tab");
      }
      const nextUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
      router.replace(nextUrl, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const fetchTickets = useCallback(async () => {
    try {
      const data = await apiFetch<TicketListResponse>("/tickets/?limit=100");
      setTickets(data.items);
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "데이터를 불러올 수 없습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const grouped = KANBAN_COLUMNS.reduce<Record<string, Ticket[]>>((acc, col) => {
    acc[col.key] = tickets.filter((ticket) => ticket.status === col.key);
    return acc;
  }, {});

  const escalated = tickets.filter((ticket) => ticket.status === "escalated");
  if (escalated.length > 0 && grouped.open) {
    grouped.open = [...grouped.open, ...escalated];
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">티켓 관리</h1>
            <p className="mt-1 text-sm text-text-secondary">
              문의 티켓과 사후 피드백을 함께 관리
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-border">
          {MAIN_TABS.map((item) => {
            const Icon = item.icon;
            const isActive = mainTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => updateMainTab(item.key)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                  isActive
                    ? "border-accent text-accent"
                    : "border-transparent text-text-muted hover:text-text-secondary",
                )}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="flex gap-4 overflow-x-auto">
          {Array.from({ length: KANBAN_COLUMNS.length }).map((_, i) => (
            <div key={i} className="min-w-[260px] flex-1">
              <div className="h-4 w-20 bg-bg-tertiary rounded mb-3 animate-pulse" />
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((__, j) => (
                  <div
                    key={j}
                    className="bg-bg-secondary border border-border rounded-lg p-3 animate-pulse"
                  >
                    <div className="h-3 w-16 bg-bg-tertiary rounded mb-2" />
                    <div className="h-4 w-full bg-bg-tertiary rounded" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">티켓 관리</h1>
            {mainTab === "tickets" && (
              <span className="text-xs text-text-muted">총 {tickets.length}건</span>
            )}
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            문의 티켓과 사후 피드백을 함께 관리
          </p>
          {mainTab === "tickets" && error && (
            <p className="mt-2 text-xs text-status-warning">{error}</p>
          )}
        </div>

        {mainTab === "tickets" && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={fetchTickets}
              className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
              aria-label="새로고침"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-border">
        {MAIN_TABS.map((item) => {
          const Icon = item.icon;
          const isActive = mainTab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => updateMainTab(item.key)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-secondary",
              )}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </button>
          );
        })}
      </div>

      {mainTab === "tickets" ? (
        <>
          <div className="flex gap-4 overflow-x-auto pb-4">
            {KANBAN_COLUMNS.map((col) => (
              <KanbanColumn
                key={col.key}
                columnKey={col.key}
                label={col.label}
                tickets={grouped[col.key] ?? []}
                onTicketClick={(ticket) => setSelectedTicketId(ticket.id)}
              />
            ))}
          </div>

          {selectedTicketId && (
            <TicketDetailPanel
              ticketId={selectedTicketId}
              onClose={() => setSelectedTicketId(null)}
              onUpdated={fetchTickets}
            />
          )}
        </>
      ) : (
        <FeedbackPanel />
      )}
    </div>
  );
}
