"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2, UserCog, Plus, X, Save, Shield, UserX, UserCheck, Edit3,
  Copy, Check, AlertTriangle, Trash2,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";
import PageHeader from "@/components/ui/PageHeader";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type {
  Operator,
  OperatorCreatePayload,
  OperatorCreateResponse,
  OperatorUpdatePayload,
} from "@/types/ops";

const DISCORD_ID_REGEX = /^\d{18,20}$/;

/* ─── 유틸 ────────────────────────────────────────────── */

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
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

function maskDiscordId(discordId: string | null): string {
  if (!discordId) return "—";
  if (discordId.length <= 8) return discordId;
  return `${discordId.slice(0, 4)}…${discordId.slice(-4)}`;
}

/* ─── 역할/상태 뱃지 ──────────────────────────────────── */

function RoleBadge({ role }: { role: "admin" | "operator" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
        role === "admin"
          ? "text-status-danger bg-status-danger/10"
          : "text-status-info bg-status-info/10",
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          role === "admin" ? "bg-status-danger" : "bg-status-info",
        )}
      />
      {role === "admin" ? "admin" : "operator"}
    </span>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
        active
          ? "text-status-ok bg-status-ok/10"
          : "text-status-neutral bg-bg-tertiary",
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          active ? "bg-status-ok" : "bg-status-neutral",
        )}
      />
      {active ? "활성" : "비활성"}
    </span>
  );
}

/* ─── 공용 입력 필드 ──────────────────────────────────── */

const INPUT_CLASS =
  "mt-1 block w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent";

/* ─── 추가 모달 ──────────────────────────────────────── */

interface CreateModalProps {
  canAssignAdmin: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function CreateOperatorModal({
  canAssignAdmin,
  onClose,
  onCreated,
}: CreateModalProps) {
  const [discordId, setDiscordId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 생성 성공 + generated_password 존재 시 1회 표시 단계로 전환
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(
    null,
  );
  const [createdUsername, setCreatedUsername] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit() {
    const trimmedDiscord = discordId.trim();
    const trimmedName = displayName.trim();
    if (!trimmedDiscord || !trimmedName) {
      setError("Discord 사용자 ID와 표시 이름은 필수입니다.");
      return;
    }
    if (!DISCORD_ID_REGEX.test(trimmedDiscord)) {
      setError("Discord 사용자 ID는 18~20자리 숫자여야 합니다.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const payload: OperatorCreatePayload = {
        discord_user_id: trimmedDiscord,
        display_name: trimmedName,
        role: canAssignAdmin && isAdmin ? "admin" : "operator",
      };
      const resp = await apiFetch<OperatorCreateResponse>("/operators", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (resp?.generated_password) {
        // 초기 비밀번호 1회 노출 단계
        setGeneratedPassword(resp.generated_password);
        setCreatedUsername(resp.username ?? null);
      } else {
        onCreated();
        onClose();
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "운영자 생성에 실패했습니다.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCopyPassword() {
    if (!generatedPassword) return;
    try {
      await navigator.clipboard.writeText(generatedPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 실패 시 사용자에게 수동 복사 안내 (드래그 선택 가능하므로 무처치)
    }
  }

  function handleConfirmAndClose() {
    onCreated();
    onClose();
  }

  // 비밀번호 노출 단계: 폼을 숨기고 1회용 박스만 보여준다
  if (generatedPassword) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-bg-secondary rounded-xl border border-border p-6 w-full max-w-md shadow-xl">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <UserCog className="w-4 h-4 text-accent" />
              운영자 생성 완료
            </h3>
          </div>

          <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
              <p className="text-sm text-status-warning leading-relaxed">
                운영포털 로그인 초기 비밀번호 — 지금 복사하여 본인에게 전달하세요.
                <br />
                <span className="text-xs text-status-warning/80">
                  이 비밀번호로 운영포털(https://192.168.100.129:8443)에
                  로그인합니다. Discord 서버 활동만 하는 경우엔 불필요합니다.
                  이 창을 닫으면 다시 조회할 수 없습니다.
                </span>
              </p>
            </div>

            {createdUsername && (
              <div className="space-y-1">
                <span className="text-xs text-text-muted">사용자명</span>
                <div className="font-mono text-sm text-text-primary px-3 py-2 bg-bg-tertiary rounded-lg border border-border break-all">
                  {createdUsername}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <span className="text-xs text-text-muted">
                운영포털 로그인 초기 비밀번호
              </span>
              <div className="flex items-stretch gap-2">
                <div className="flex-1 font-mono text-sm text-text-primary px-3 py-2 bg-bg-tertiary rounded-lg border border-border break-all select-all">
                  {generatedPassword}
                </div>
                <button
                  type="button"
                  onClick={handleCopyPassword}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap",
                    copied
                      ? "bg-status-ok/15 text-status-ok border border-status-ok/40"
                      : "bg-accent text-white hover:bg-accent/90",
                  )}
                  title="클립보드에 복사"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copied ? "복사됨" : "복사"}
                </button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={handleConfirmAndClose}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              <Check className="w-4 h-4" />
              확인
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-bg-secondary rounded-xl border border-border p-6 w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <UserCog className="w-4 h-4 text-accent" />
            운영자 추가
          </h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-status-danger/10 border border-status-danger/30 text-status-danger text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <label className="block">
            <span className="text-sm text-text-secondary">
              Discord 사용자 ID <span className="text-status-danger">*</span>
            </span>
            <input
              type="text"
              value={discordId}
              onChange={(e) => setDiscordId(e.target.value)}
              placeholder="18~19자리 숫자"
              className={INPUT_CLASS}
              autoComplete="off"
              maxLength={32}
              inputMode="numeric"
            />
            <span className="mt-1 block text-xs text-text-muted leading-relaxed">
              이 Discord 사용자 ID를 가진 사람이 Discord 서버에서 &apos;운영진&apos;
              역할을 자동으로 받습니다.
            </span>
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">
              표시 이름 <span className="text-status-danger">*</span>
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="예: 김운영"
              className={INPUT_CLASS}
              maxLength={100}
            />
          </label>

          {canAssignAdmin && (
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isAdmin}
                onChange={(e) => setIsAdmin(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-border text-accent focus:ring-accent bg-bg-tertiary"
              />
              <span className="text-sm text-text-secondary leading-relaxed">
                관리자(admin) 권한 부여
                <span className="block text-xs text-text-muted mt-0.5">
                  체크 시 admin, 미체크 시 operator로 생성됩니다.
                </span>
              </span>
            </label>
          )}

          <div className="rounded-lg bg-bg-tertiary/50 border border-border p-3 text-xs text-text-muted leading-relaxed">
            로그인 ID와 초기 비밀번호는 자동으로 생성됩니다. 생성 직후 초기
            비밀번호가 1회 표시되므로 반드시 복사하여 본인에게 전달하세요.
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isSaving ? "생성 중..." : "생성"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── 수정 모달 ──────────────────────────────────────── */

interface EditModalProps {
  operator: Operator;
  isSelf: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

function EditOperatorModal({
  operator,
  isSelf,
  onClose,
  onUpdated,
}: EditModalProps) {
  const [form, setForm] = useState({
    display_name: operator.display_name,
    role: operator.role,
    is_active: operator.is_active,
    discord_user_id: operator.discord_user_id ?? "",
    password: "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setIsSaving(true);
    setError(null);
    try {
      const body: OperatorUpdatePayload = {};
      const newDisplayName = form.display_name.trim();
      if (newDisplayName && newDisplayName !== operator.display_name) {
        body.display_name = newDisplayName;
      }
      if (!isSelf && form.role !== operator.role) {
        body.role = form.role;
      }
      if (!isSelf && form.is_active !== operator.is_active) {
        body.is_active = form.is_active;
      }
      const newDiscord = form.discord_user_id.trim();
      const origDiscord = operator.discord_user_id ?? "";
      if (newDiscord !== origDiscord) {
        body.discord_user_id = newDiscord === "" ? null : newDiscord;
      }
      if (form.password) {
        body.password = form.password;
      }

      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }

      await apiFetch(`/operators/${operator.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onUpdated();
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "운영자 수정에 실패했습니다.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-bg-secondary rounded-xl border border-border p-6 w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-accent" />
            운영자 수정
          </h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {isSelf && (
          <div className="mb-4 p-3 rounded-lg bg-status-warning/10 border border-status-warning/30 text-status-warning text-xs">
            자기 자신의 역할·활성 상태는 변경할 수 없습니다. 표시 이름·Discord
            ID·비밀번호만 수정할 수 있습니다.
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-status-danger/10 border border-status-danger/30 text-status-danger text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <span className="text-xs text-text-muted">사용자명 (변경 불가)</span>
            <p className="mt-0.5 font-mono text-sm text-text-primary">
              {operator.username}
            </p>
          </div>

          <label className="block">
            <span className="text-sm text-text-secondary">표시 이름</span>
            <input
              type="text"
              value={form.display_name}
              onChange={(e) =>
                setForm((f) => ({ ...f, display_name: e.target.value }))
              }
              className={INPUT_CLASS}
              maxLength={100}
            />
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">역할</span>
            <select
              value={form.role}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  role: e.target.value as "admin" | "operator",
                }))
              }
              disabled={isSelf}
              className={cn(INPUT_CLASS, isSelf && "opacity-50 cursor-not-allowed")}
            >
              <option value="operator">operator (일반 운영자)</option>
              <option value="admin">admin (관리자)</option>
            </select>
          </label>

          <label
            className={cn(
              "flex items-center gap-2 cursor-pointer",
              isSelf && "opacity-50 cursor-not-allowed",
            )}
          >
            <input
              type="checkbox"
              checked={form.is_active}
              disabled={isSelf}
              onChange={(e) =>
                setForm((f) => ({ ...f, is_active: e.target.checked }))
              }
              className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-bg-tertiary"
            />
            <span className="text-sm text-text-secondary">활성 계정</span>
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">Discord 사용자 ID</span>
            <input
              type="text"
              value={form.discord_user_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, discord_user_id: e.target.value }))
              }
              placeholder="비우면 Discord 역할 연동 해제"
              className={INPUT_CLASS}
              autoComplete="off"
              maxLength={32}
            />
            <span className="mt-1 block text-xs text-text-muted">
              변경 시 Discord &apos;운영진&apos; 역할이 자동으로 재부여/해제됩니다.
            </span>
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">
              새 비밀번호{" "}
              <span className="text-xs text-text-muted">(변경 시에만 입력)</span>
            </span>
            <input
              type="password"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
              placeholder="미입력 시 기존 비밀번호 유지"
              className={INPUT_CLASS}
              autoComplete="new-password"
            />
          </label>

        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isSaving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── 메인 페이지 ────────────────────────────────────── */

export default function OperatorsPage() {
  const { operator: me } = useAuth();
  const [items, setItems] = useState<Operator[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<Operator | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Operator | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [activateTarget, setActivateTarget] = useState<Operator | null>(null);
  const [isActivating, setIsActivating] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<Operator | null>(null);
  const [isPurging, setIsPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const fetchOperators = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // 백엔드는 `/api/operators`를 배열 또는 { items } 형태로 응답할 수 있음 → 양쪽 호환
      const raw = await apiFetch<Operator[] | { items: Operator[] }>(
        "/operators",
      );
      const list = Array.isArray(raw) ? raw : (raw.items ?? []);
      setItems(list);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "운영자 목록 조회에 실패했습니다.",
      );
      setItems([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOperators();
  }, [fetchOperators]);

  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setIsDeactivating(true);
    setError(null);
    try {
      await apiFetch(`/operators/${deactivateTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: false }),
      });
      setDeactivateTarget(null);
      await fetchOperators();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "비활성화에 실패했습니다.",
      );
    } finally {
      setIsDeactivating(false);
    }
  }

  async function handleActivate() {
    if (!activateTarget) return;
    setIsActivating(true);
    setError(null);
    try {
      await apiFetch(`/operators/${activateTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: true }),
      });
      setActivateTarget(null);
      await fetchOperators();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "활성화에 실패했습니다.",
      );
    } finally {
      setIsActivating(false);
    }
  }

  async function handlePurge() {
    if (!purgeTarget) return;
    setIsPurging(true);
    setPurgeError(null);
    try {
      await apiFetch(`/operators/${purgeTarget.id}/purge`, {
        method: "DELETE",
      });
      setPurgeTarget(null);
      await fetchOperators();
    } catch (err) {
      // 409 참조 충돌 시 백엔드 detail(문자열)에 이미 참조 건수가 포함되어 있음
      const base =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "영구 삭제에 실패했습니다.";
      const is409 = err instanceof ApiError && err.status === 409;
      setPurgeError(
        is409 ? `${base} 대신 '비활성화' 버튼을 이용하세요.` : base,
      );
    } finally {
      setIsPurging(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="운영자 관리"
        description="운영진 계정 관리 및 Discord 역할 자동 연동"
        actions={
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            운영자 추가
          </button>
        }
      />

      {/* 도움말 배너 */}
      <div className="bg-bg-secondary border border-border rounded-lg px-4 py-3 text-xs text-text-secondary flex items-start gap-2">
        <Shield className="w-4 h-4 text-accent shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          Discord 사용자 ID를 지정하면 봇이 해당 사용자에게{" "}
          <span className="font-medium text-text-primary">&apos;운영진&apos;</span>
          역할을 자동 부여합니다. 마지막 admin 계정을 비활성화하거나 역할을
          강등할 수 없습니다.
        </p>
      </div>

      {/* 에러 */}
      {error && (
        <div className="rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 underline text-xs"
          >
            닫기
          </button>
        </div>
      )}

      {/* 로딩 */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      )}

      {/* 빈 상태 */}
      {!isLoading && items.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <UserCog className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">등록된 운영자가 없습니다.</p>
        </div>
      )}

      {/* 목록 테이블 */}
      {!isLoading && items.length > 0 && (
        <div className="w-full overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-bg-tertiary">
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  사용자명
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  표시 이름
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  역할
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  Discord ID
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  상태
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  마지막 로그인
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-text-secondary uppercase tracking-wider">
                  액션
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((op) => {
                const isSelf = me?.id === op.id;
                return (
                  <tr
                    key={op.id}
                    className="transition-colors hover:bg-bg-tertiary/50"
                  >
                    <td className="px-4 py-3 text-sm font-mono text-text-primary">
                      {op.username}
                      {isSelf && (
                        <span className="ml-2 text-[10px] text-accent uppercase tracking-wider">
                          (나)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary">
                      {op.display_name}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <RoleBadge role={op.role} />
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-text-secondary">
                      {maskDiscordId(op.discord_user_id)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <ActiveBadge active={op.is_active} />
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-text-secondary whitespace-nowrap">
                      {formatDateTime(op.last_login_at)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditTarget(op)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
                          title="수정"
                        >
                          <Edit3 className="w-3 h-3" />
                          수정
                        </button>
                        {op.is_active ? (
                          <button
                            type="button"
                            onClick={() => setDeactivateTarget(op)}
                            disabled={isSelf}
                            className={cn(
                              "inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg transition-colors",
                              isSelf
                                ? "bg-bg-tertiary text-text-muted cursor-not-allowed opacity-50"
                                : "border border-status-danger/40 text-status-danger hover:bg-status-danger/10",
                            )}
                            title={
                              isSelf
                                ? "자기 자신은 비활성화할 수 없습니다"
                                : "비활성화 (Discord 운영진 역할 함께 해제)"
                            }
                          >
                            <UserX className="w-3 h-3" />
                            비활성화
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setActivateTarget(op)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-status-ok/40 text-status-ok hover:bg-status-ok/10 transition-colors"
                            title="활성화 (Discord 운영진 역할 자동 재부여)"
                          >
                            <UserCheck className="w-3 h-3" />
                            활성화
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setPurgeError(null);
                            setPurgeTarget(op);
                          }}
                          disabled={isSelf}
                          className={cn(
                            "inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg transition-colors",
                            isSelf
                              ? "bg-bg-tertiary text-text-muted cursor-not-allowed opacity-50"
                              : "border border-status-danger/60 text-status-danger hover:bg-status-danger/15",
                          )}
                          title={
                            isSelf
                              ? "자기 자신은 영구 삭제할 수 없습니다"
                              : "영구 삭제 (되돌릴 수 없음)"
                          }
                        >
                          <Trash2 className="w-3 h-3" />
                          영구 삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 추가 모달 */}
      {showCreate && (
        <CreateOperatorModal
          canAssignAdmin={me?.role === "admin"}
          onClose={() => setShowCreate(false)}
          onCreated={fetchOperators}
        />
      )}

      {/* 수정 모달 */}
      {editTarget && (
        <EditOperatorModal
          operator={editTarget}
          isSelf={me?.id === editTarget.id}
          onClose={() => setEditTarget(null)}
          onUpdated={fetchOperators}
        />
      )}

      {/* 활성화 확인 모달 */}
      <ConfirmModal
        open={activateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setActivateTarget(null);
        }}
        title="운영자를 활성화하시겠습니까?"
        description={
          activateTarget
            ? `"${activateTarget.display_name}" (${activateTarget.username}) 계정을 다시 활성화합니다. 로그인이 가능해지며, 연결된 Discord 사용자가 있으면 '운영진' 역할이 자동으로 재부여됩니다.`
            : ""
        }
        confirmLabel="활성화"
        cancelLabel="취소"
        variant="default"
        onConfirm={handleActivate}
        isLoading={isActivating}
      />

      {/* 비활성화 확인 모달 */}
      <ConfirmModal
        open={deactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null);
        }}
        title="운영자를 비활성화하시겠습니까?"
        description={
          deactivateTarget
            ? `"${deactivateTarget.display_name}" (${deactivateTarget.username}) 계정이 로그인할 수 없게 됩니다. 연결된 Discord '운영진' 역할도 함께 해제됩니다. (마지막 admin은 비활성화 불가)`
            : ""
        }
        confirmLabel="비활성화"
        variant="danger"
        onConfirm={handleDeactivate}
        isLoading={isDeactivating}
      />

      {/* 영구 삭제 확인 모달 */}
      <ConfirmModal
        open={purgeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPurgeTarget(null);
            setPurgeError(null);
          }
        }}
        title="⚠️ 영구 삭제 확인"
        description={
          purgeTarget
            ? `${purgeTarget.display_name} (${purgeTarget.username})를 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다.\n\n※ 이 운영자가 기존 대회/티켓/감사 기록을 남겼다면 영구 삭제는 불가하며 '비활성화'만 가능합니다.${purgeError ? `\n\n오류: ${purgeError}` : ""}`
            : ""
        }
        confirmLabel="영구 삭제"
        variant="danger"
        onConfirm={handlePurge}
        isLoading={isPurging}
      />
    </div>
  );
}
