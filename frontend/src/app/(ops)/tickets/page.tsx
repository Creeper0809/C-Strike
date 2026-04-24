"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  RefreshCw,
  X,
  Send,
  User,
  MessageSquare,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  TICKET_STATUS_MAP,
  PRIORITY_MAP,
  STATUS_COLORS,
} from "@/lib/constants";
import type { Ticket } from "@/types/ops";

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

/* ────────────────────── Constants ────────────────────── */

const KANBAN_COLUMNS: { key: string; label: string }[] = [
  { key: "open", label: "열림" },
  { key: "in_progress", label: "처리 중" },
  { key: "resolved", label: "해결됨" },
  { key: "rejected", label: "반려됨" },
];

const TYPE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  dispute: { label: "이의제기", color: "text-status-info", bg: "bg-status-info/10" },
  violation: { label: "규정위반", color: "text-status-danger", bg: "bg-status-danger/10" },
};

/* ────────────────────── Helpers ────────────────────── */

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("ko-KR", {
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

/* ────────────────────── PriorityBadge ────────────────────── */

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
        config.color === "neutral" && "bg-bg-tertiary"
      )}
    >
      {config.label}
    </span>
  );
}

/* ────────────────────── TypeBadge ────────────────────── */

function TypeBadge({ type }: { type: string }) {
  const config = TYPE_LABELS[type];
  if (!config) return <span className="text-xs text-text-muted">{type}</span>;

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium",
        config.color,
        config.bg
      )}
    >
      {config.label}
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
      {/* 상단: 번호 + 우선순위 */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-text-muted">
          {ticket.ticket_number}
        </span>
        <PriorityBadge priority={ticket.priority} />
      </div>

      {/* 제목 */}
      <p className="text-sm font-medium text-text-primary truncate">
        {ticket.title}
      </p>

      {/* 하단: 유형 + 팀 + 담당자 */}
      <div className="flex items-center gap-2 flex-wrap">
        <TypeBadge type={ticket.type} />
        {ticket.team_name && (
          <span className="text-xs text-text-muted">
            {ticket.team_name}
          </span>
        )}
        {ticket.assigned_to && (
          <span className="flex items-center gap-1 text-xs text-text-secondary ml-auto">
            <User className="w-3 h-3" />
            {ticket.assigned_to_name ?? ticket.assigned_to}
          </span>
        )}
      </div>

      {/* 생성 시각 */}
      <p className="text-xs text-text-muted">
        {formatRelative(ticket.created_at)}
      </p>
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
      {/* 열 헤더 */}
      <div className="flex items-center gap-2 mb-3 px-1">
        <h3 className={cn("text-sm font-medium", colorClass)}>
          {label}
        </h3>
        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-medium bg-bg-tertiary text-text-secondary">
          {tickets.length}
        </span>
      </div>

      {/* 카드 목록 */}
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
      {/* 백드롭 */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
      />

      {/* 패널 */}
      <div className="fixed right-0 top-0 z-50 h-full w-[420px] bg-bg-elevated border-l border-border overflow-y-auto">
        {/* 헤더 */}
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
                  statusConfig.color === "neutral" && "bg-bg-tertiary"
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
          {/* 제목 + 설명 */}
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-text-primary">
              {detail.title}
            </h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              {detail.description}
            </p>
          </div>

          {/* 메타 정보 */}
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
              <span className="text-text-primary">
                {detail.team_name ?? "-"}
              </span>
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

          {/* 상태/우선순위 변경 */}
          <div className="bg-bg-secondary border border-border rounded-lg p-3 space-y-3">
            <h4 className="text-xs font-medium text-text-secondary">
              상태 변경
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-text-muted mb-1 block">
                  상태
                </span>
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
                <span className="text-xs text-text-muted mb-1 block">
                  우선순위
                </span>
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
                  statusSaving && "opacity-50 cursor-not-allowed"
                )}
              >
                {statusSaving ? "저장 중..." : "변경 저장"}
              </button>
            )}
          </div>

          {error && (
            <p className="text-xs text-status-danger">{error}</p>
          )}

          {/* 메시지 타임라인 */}
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
                      <span className="text-xs text-status-info">
                        Discord 전송됨
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 응답 폼 */}
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
                <span className="text-xs text-text-secondary">
                  Discord 전송
                </span>
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
                  responseSending && "opacity-50 cursor-not-allowed"
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

/* ────────────────────── TicketCreateModal ────────────────────── */

function TicketCreateModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<"dispute" | "violation">("dispute");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [teamName, setTeamName] = useState("");
  const [priority, setPriority] = useState("medium");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const trimmedTitle = title.trim();
    const trimmedDesc = description.trim();

    if (!trimmedTitle) {
      setError("제목을 입력해 주세요.");
      return;
    }
    if (!trimmedDesc) {
      setError("설명을 입력해 주세요.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiFetch("/tickets/", {
        method: "POST",
        body: JSON.stringify({
          type,
          title: trimmedTitle,
          description: trimmedDesc,
          team_name: teamName.trim() || null,
          priority,
        }),
      });
      resetForm();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "티켓 생성에 실패했습니다.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function resetForm() {
    setType("dispute");
    setTitle("");
    setDescription("");
    setTeamName("");
    setPriority("medium");
    setError(null);
  }

  function handleOpenChange(value: boolean) {
    if (!value) resetForm();
    onOpenChange(value);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 bg-bg-elevated border border-border rounded-xl p-6 shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
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
            새 티켓 생성
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-text-secondary leading-relaxed">
            이의제기 또는 규정위반 티켓을 생성합니다.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            {/* 유형 */}
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                유형
              </span>
              <select
                value={type}
                onChange={(e) =>
                  setType(e.target.value as "dispute" | "violation")
                }
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
              >
                <option value="dispute">이의제기</option>
                <option value="violation">규정위반</option>
              </select>
            </label>

            {/* 제목 */}
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                제목
              </span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="티켓 제목을 입력하세요"
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
              />
            </label>

            {/* 설명 */}
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                설명
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="상세 설명을 입력하세요"
                rows={4}
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors resize-none"
              />
            </label>

            {/* 팀명 */}
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                팀명 (선택)
              </span>
              <input
                type="text"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="관련 팀명 (선택사항)"
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
              />
            </label>

            {/* 우선순위 */}
            <label className="block">
              <span className="text-xs text-text-secondary mb-1 block">
                우선순위
              </span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
              >
                {Object.entries(PRIORITY_MAP).map(([key, val]) => (
                  <option key={key} value={key}>
                    {val.label}
                  </option>
                ))}
              </select>
            </label>

            {error && (
              <p className="text-xs text-status-danger">{error}</p>
            )}
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors"
              >
                취소
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleCreate}
              disabled={isSubmitting}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-lg bg-accent hover:bg-accent-hover text-white transition-colors",
                isSubmitting && "opacity-50 cursor-not-allowed"
              )}
            >
              {isSubmitting ? "생성 중..." : "티켓 생성"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ────────────────────── TicketsPage ────────────────────── */

export default function TicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [createModal, setCreateModal] = useState(false);

  const fetchTickets = useCallback(async () => {
    try {
      const data = await apiFetch<TicketListResponse>(
        "/tickets/?limit=200"
      );
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

  /* 칸반 열별 그룹핑 */
  const grouped = KANBAN_COLUMNS.reduce<Record<string, Ticket[]>>(
    (acc, col) => {
      acc[col.key] = tickets.filter((t) => t.status === col.key);
      return acc;
    },
    {}
  );

  /* escalated 티켓은 open 열에 포함 */
  const escalated = tickets.filter((t) => t.status === "escalated");
  if (escalated.length > 0 && grouped["open"]) {
    grouped["open"] = [...grouped["open"], ...escalated];
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-lg font-semibold mb-6">티켓 관리</h1>
        <div className="flex gap-4 overflow-x-auto">
          {Array.from({ length: 4 }).map((_, i) => (
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
    <div>
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">티켓 관리</h1>
          <span className="text-xs text-text-muted">
            총 {tickets.length}건
          </span>
          {error && (
            <span className="text-xs text-status-warning">{error}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={fetchTickets}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            aria-label="새로고침"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            새 티켓
          </button>
        </div>
      </div>

      {/* 칸반 보드 */}
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

      {/* 상세 패널 */}
      {selectedTicketId && (
        <TicketDetailPanel
          ticketId={selectedTicketId}
          onClose={() => setSelectedTicketId(null)}
          onUpdated={fetchTickets}
        />
      )}

      {/* 생성 모달 */}
      <TicketCreateModal
        open={createModal}
        onOpenChange={setCreateModal}
        onCreated={fetchTickets}
      />
    </div>
  );
}
