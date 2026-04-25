"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2, Users, CheckCircle, XOctagon,
  X, Shield, Globe, Server, Save, Trash2, Plus, Copy, Eye, EyeOff, Box,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import TeamRuntimeSection from "./TeamRuntimeSection";
import {
  TEAM_STATUS_MAP,
  TEAM_MEMBER_ROLE_MAP,
  TEAM_MEMBER_STATUS_MAP,
} from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import StatusIndicator from "@/components/ui/StatusIndicator";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type {
  CompetitionListItem,
  CompetitionListResponse,
  DiscordDirectoryMemberItem,
  DiscordDirectoryMemberListResponse,
  DiscordDirectorySyncResponse,
  TeamListItem,
  TeamListResponse,
  TeamDetail,
  TeamMemberCreatePayload,
  TeamMemberCreateResponse,
  TeamSshPasswordRevealResponse,
  TeamMemberItem,
  TeamServiceItem,
} from "@/types/ops";

/* ── 상수 ── */

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "pending", label: "승인 대기" },
  { value: "approved", label: "승인됨" },
  { value: "active", label: "활성" },
  { value: "disqualified", label: "실격" },
  { value: "withdrawn", label: "탈퇴" },
];

const PAGE_SIZE = 20;
const CREATE_ALLOCATION_OPTIONS = [
  { value: "auto", label: "자동 배정" },
  { value: "manual", label: "수동 입력" },
] as const;
const TEAM_DRAWER_TABS = [
  { value: "overview", label: "개요", icon: Shield },
  { value: "members", label: "팀원", icon: Users },
  { value: "services", label: "서비스", icon: Server },
  { value: "runtime", label: "런타임", icon: Box },
] as const;

/* ── 유틸 ── */

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AddTeamMemberModal({
  competitionId,
  teamId,
  teamName,
  onClose,
  onAdded,
}: {
  competitionId: string;
  teamId: string;
  teamName: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [members, setMembers] = useState<DiscordDirectoryMemberItem[]>([]);
  const [query, setQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<"captain" | "member">("member");
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const resp = await apiFetch<DiscordDirectoryMemberListResponse>(
        `/discord-directory/members?competition_id=${competitionId}&team_id=${teamId}&limit=500`,
      );
      setMembers(resp.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "디스코드 멤버 조회에 실패했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, teamId]);

  useEffect(() => {
    loadDirectory();
  }, [loadDirectory]);

  const filteredMembers = members.filter((member) => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return true;
    return [
      member.display_name,
      member.username,
      member.global_name,
      member.nick,
      member.discord_user_id,
    ].some((value) => String(value || "").toLowerCase().includes(normalized));
  });

  const selectedMember = members.find(
    (member) => member.discord_user_id === selectedUserId,
  ) ?? null;

  async function handleSync() {
    setIsSyncing(true);
    setError(null);
    try {
      await apiFetch<DiscordDirectorySyncResponse>("/discord-directory/sync", {
        method: "POST",
      });
      await loadDirectory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "멤버 동기화에 실패했습니다.");
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleSubmit() {
    if (!selectedMember) {
      setError("추가할 디스코드 멤버를 선택하세요.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const payload: TeamMemberCreatePayload = {
        discord_user_id: selectedMember.discord_user_id,
        role: selectedRole,
      };
      await apiFetch<TeamMemberCreateResponse>(
        `/v1/competitions/${competitionId}/teams/${teamId}/members`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "팀원 추가에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-bg-secondary rounded-xl border border-border p-6 w-full max-w-2xl shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-lg font-semibold text-text-primary">팀원 추가</h3>
            <p className="mt-1 text-sm text-text-muted">{teamName} 팀에 디스코드 멤버를 추가합니다.</p>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름, 사용자명, Discord ID 검색"
              className="flex-1 px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={handleSync}
              disabled={isSyncing || isLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors"
            >
              {isSyncing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Globe className="w-3.5 h-3.5" />
              )}
              {isSyncing ? "동기화 중..." : "디스코드 동기화"}
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
            {isLoading ? (
              <div className="flex items-center justify-center py-12 text-text-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : filteredMembers.length === 0 ? (
              <p className="px-4 py-8 text-sm text-text-muted text-center">
                선택 가능한 디스코드 멤버가 없습니다.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {filteredMembers.map((member) => {
                  const alreadyAssignedElsewhere =
                    Boolean(member.assigned_team_id) && !member.is_current_team_member;
                  const selected = selectedUserId === member.discord_user_id;
                  return (
                    <button
                      key={member.discord_user_id}
                      type="button"
                      disabled={alreadyAssignedElsewhere}
                      onClick={() => setSelectedUserId(member.discord_user_id)}
                      className={cn(
                        "w-full px-4 py-3 text-left transition-colors",
                        alreadyAssignedElsewhere
                          ? "bg-bg-secondary/40 text-text-muted cursor-not-allowed opacity-60"
                          : selected
                            ? "bg-accent/10"
                            : "hover:bg-bg-tertiary",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-text-primary">{member.display_name}</p>
                          <p className="mt-0.5 text-xs text-text-muted font-mono">
                            @{member.username} · {member.discord_user_id}
                          </p>
                        </div>
                        <div className="text-right text-xs">
                          {alreadyAssignedElsewhere ? (
                            <span className="text-status-warning">
                              {member.assigned_team_name} 팀 소속
                            </span>
                          ) : member.is_current_team_member ? (
                            <span className="text-accent">이미 현재 팀 소속</span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-bg-tertiary/50 border border-border p-3">
              <span className="text-xs text-text-muted">선택된 멤버</span>
              <p className="mt-1 text-sm text-text-primary">
                {selectedMember ? selectedMember.display_name : "아직 선택되지 않았습니다."}
              </p>
              {selectedMember && (
                <p className="mt-0.5 text-xs text-text-muted font-mono">
                  @{selectedMember.username} · {selectedMember.discord_user_id}
                </p>
              )}
            </div>

            <label className="block">
              <span className="text-xs text-text-muted">팀 내 역할</span>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as "captain" | "member")}
                className="mt-1 block w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="member">일반 팀원</option>
                <option value="captain">팀장</option>
              </select>
            </label>
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
            disabled={isSaving || !selectedMember}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {isSaving ? "추가 중..." : selectedMember?.is_current_team_member ? "팀 정보 갱신" : "팀원 추가"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 팀 상세 드로어 ── */

function TeamDrawer({
  competitionId,
  teamId,
  onClose,
  onMutated,
}: {
  competitionId: string;
  teamId: string;
  onClose: () => void;
  onMutated: () => void;
}) {
  type TeamDrawerTab = (typeof TEAM_DRAWER_TABS)[number]["value"];
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [members, setMembers] = useState<TeamMemberItem[]>([]);
  const [services, setServices] = useState<TeamServiceItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TeamDrawerTab>("overview");

  /* 승인 / 실격 / 삭제 모달 */
  const [showApprove, setShowApprove] = useState(false);
  const [showDisqualify, setShowDisqualify] = useState(false);
  const [disqualifyReason, setDisqualifyReason] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [isActioning, setIsActioning] = useState(false);

  /* 수정 모드 */
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "", subnet: "", gateway_ip: "", vpn_profile_issued: false,
    ssh_port: "22", ssh_user: "", ssh_password: "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [revealedSshPassword, setRevealedSshPassword] = useState<string | null>(null);
  const [isRevealingPassword, setIsRevealingPassword] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);

  const [showAddMember, setShowAddMember] = useState(false);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [d, mRaw, sRaw] = await Promise.all([
        apiFetch<TeamDetail>(`/v1/competitions/${competitionId}/teams/${teamId}`),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apiFetch<any>(`/v1/competitions/${competitionId}/teams/${teamId}/members`),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apiFetch<any>(`/v1/competitions/${competitionId}/teams/${teamId}/services`),
      ]);
      setDetail(d);
      setRevealedSshPassword(null);
      setPasswordCopied(false);
      setMembers(Array.isArray(mRaw) ? mRaw : (mRaw.items ?? []));
      setServices(Array.isArray(sRaw) ? sRaw : (sRaw.items ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "팀 정보 조회에 실패했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, teamId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    setActiveTab("overview");
    setIsEditing(false);
    setShowAddMember(false);
  }, [teamId]);

  function startEditing() {
    if (!detail) return;
    setEditForm({
      name: detail.name || "",
      subnet: detail.subnet || "",
      gateway_ip: detail.gateway_ip || "",
      vpn_profile_issued: detail.vpn_profile_issued,
      ssh_port: String(detail.ssh_port ?? 22),
      ssh_user: detail.ssh_user || "",
      ssh_password: "",  // 비밀번호는 항상 빈 값 (변경 시에만 전송)
    });
    setIsEditing(true);
  }

  async function handleRevealSshPassword() {
    setIsRevealingPassword(true);
    setError(null);
    try {
      const res = await apiFetch<TeamSshPasswordRevealResponse>(
        `/v1/competitions/${competitionId}/teams/${teamId}/ssh-password/reveal`,
        { method: "POST" },
      );
      setRevealedSshPassword(res.ssh_password);
      setPasswordCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "SSH 비밀번호 조회에 실패했습니다.");
    } finally {
      setIsRevealingPassword(false);
    }
  }

  async function handleCopySshPassword() {
    if (!revealedSshPassword) return;
    try {
      await navigator.clipboard.writeText(revealedSshPassword);
      setPasswordCopied(true);
    } catch {
      setError("클립보드 복사에 실패했습니다.");
    }
  }

  async function handleSave() {
    if (!detail) return;
    setIsSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      const newName = editForm.name.trim();
      const newSubnet = editForm.subnet.trim() || null;
      const newGateway = editForm.gateway_ip.trim() || null;
      if (newName && newName !== detail.name) body.name = newName;
      if (newSubnet !== detail.subnet) body.subnet = newSubnet;
      if (newGateway !== detail.gateway_ip) body.gateway_ip = newGateway;
      if (editForm.vpn_profile_issued !== detail.vpn_profile_issued) body.vpn_profile_issued = editForm.vpn_profile_issued;
      const newPort = parseInt(editForm.ssh_port, 10);
      if (!isNaN(newPort) && newPort > 0 && newPort !== (detail.ssh_port ?? 22)) body.ssh_port = newPort;
      const newSshUser = editForm.ssh_user.trim() || null;
      if (newSshUser !== detail.ssh_user) body.ssh_user = newSshUser;
      if (editForm.ssh_password) body.ssh_password = editForm.ssh_password;
      if (Object.keys(body).length === 0) { setIsEditing(false); return; }
      await apiFetch(`/v1/competitions/${competitionId}/teams/${teamId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setIsEditing(false);
      await fetchAll();
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "수정에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleApprove() {
    setIsActioning(true);
    try {
      await apiFetch(`/v1/competitions/${competitionId}/teams/${teamId}/approve`, { method: "POST" });
      setShowApprove(false);
      await fetchAll();
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "승인에 실패했습니다.");
    } finally {
      setIsActioning(false);
    }
  }

  async function handleDisqualify() {
    if (!disqualifyReason.trim()) return;
    setIsActioning(true);
    try {
      await apiFetch(`/v1/competitions/${competitionId}/teams/${teamId}/disqualify`, {
        method: "POST",
        body: JSON.stringify({ reason: disqualifyReason.trim() }),
      });
      setShowDisqualify(false);
      setDisqualifyReason("");
      await fetchAll();
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "실격 처리에 실패했습니다.");
    } finally {
      setIsActioning(false);
    }
  }

  async function handleDelete() {
    setIsActioning(true);
    try {
      await apiFetch(`/v1/competitions/${competitionId}/teams/${teamId}`, {
        method: "DELETE",
      });
      setShowDelete(false);
      onMutated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "팀 삭제에 실패했습니다.");
      setIsActioning(false);
    }
  }

  const statusInfo = detail ? (TEAM_STATUS_MAP[detail.status] || { label: detail.status, color: "neutral" as const }) : null;
  const inputClass = "w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <>
      {/* 오버레이 */}
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* 드로어 패널 */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-bg-primary border-l border-border shadow-2xl overflow-y-auto">
        {/* 헤더 */}
        <div className="sticky top-0 z-10 bg-bg-primary border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary truncate">
            {detail?.name || "팀 상세"}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
              {error}
              <button onClick={() => setError(null)} className="ml-2 underline">닫기</button>
            </div>
          )}

	          {!isLoading && detail && (
	            <>
              {/* 상태 + 액션 */}
	              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {statusInfo && <StatusIndicator status={statusInfo.color} label={statusInfo.label} />}
                  <span className="text-xs text-text-muted font-mono">{detail.team_code}</span>
                </div>
                <div className="flex items-center gap-2">
                  {detail.status === "pending" && (
                    <button onClick={() => setShowApprove(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors">
                      <CheckCircle className="w-4 h-4" /> 승인
                    </button>
                  )}
                  {detail.status === "active" && (
                    <button onClick={() => setShowDisqualify(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-status-danger/10 text-status-danger hover:bg-status-danger/20 transition-colors">
                      <XOctagon className="w-4 h-4" /> 실격
                    </button>
                  )}
                  <button
                    onClick={() => setShowDelete(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-status-danger/40 text-status-danger hover:bg-status-danger/10 transition-colors"
                    title="팀을 영구 삭제합니다"
                  >
                    <Trash2 className="w-4 h-4" /> 삭제
                  </button>
	                </div>
	              </div>

                <div className="overflow-x-auto border-b border-border">
                  <div className="flex min-w-max gap-1">
                    {TEAM_DRAWER_TABS.map((tab) => {
                      const TabIcon = tab.icon;
                      const isActive = activeTab === tab.value;
                      const countLabel =
                        tab.value === "members"
                          ? `${members.length}`
                          : tab.value === "services"
                            ? `${services.length}`
                            : null;

                      return (
                        <button
                          key={tab.value}
                          type="button"
                          onClick={() => setActiveTab(tab.value)}
                          className={cn(
                            "inline-flex items-center gap-2 rounded-t-lg border-b-2 px-3 py-2 text-sm transition-colors",
                            isActive
                              ? "border-accent text-accent"
                              : "border-transparent text-text-muted hover:text-text-primary",
                          )}
                        >
                          <TabIcon className="w-4 h-4" />
                          {tab.label}
                          {countLabel && (
                            <span className="text-xs text-text-muted">{countLabel}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {activeTab === "overview" && (
                  <section className="bg-bg-secondary rounded-xl p-5 border border-border">
	                <div className="flex items-center justify-between mb-4">
	                  <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
	                    <Shield className="w-4 h-4 text-text-muted" /> 팀 정보
                  </h3>
                  {!isEditing ? (
                    <button onClick={startEditing} className="text-xs text-text-muted hover:text-text-primary transition-colors">수정</button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setIsEditing(false)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors">
                        <X className="w-3 h-3" /> 취소
                      </button>
                      <button onClick={handleSave} disabled={isSaving} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50">
                        <Save className="w-3 h-3" /> {isSaving ? "저장 중..." : "저장"}
                      </button>
                    </div>
                  )}
                </div>

                {!isEditing ? (
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div><dt className="text-xs text-text-muted">팀장 Discord</dt><dd className="mt-0.5 text-sm text-text-primary font-mono">{detail.captain_discord_id}</dd></div>
                    <div><dt className="text-xs text-text-muted">Discord 역할 ID</dt><dd className="mt-0.5 text-sm text-text-primary font-mono">{detail.discord_role_id || "-"}</dd></div>
                    <div><dt className="text-xs text-text-muted">VPN 대역</dt><dd className="mt-0.5 text-sm text-text-primary font-mono">{detail.subnet || "-"}</dd></div>
                    <div><dt className="text-xs text-text-muted">팀 서버 IP</dt><dd className="mt-0.5 text-sm text-text-primary font-mono">{detail.gateway_ip || "-"}</dd></div>
                    <div><dt className="text-xs text-text-muted">VPN 프로파일</dt><dd className="mt-0.5 text-sm text-text-primary">{detail.vpn_profile_issued ? "발급됨" : "미발급"}</dd></div>
                    <div><dt className="text-xs text-text-muted">등록일</dt><dd className="mt-0.5 text-sm text-text-primary">{formatDate(detail.registered_at)}</dd></div>
                    <div><dt className="text-xs text-text-muted">승인일</dt><dd className="mt-0.5 text-sm text-text-primary">{formatDate(detail.approved_at)}</dd></div>
                    <div><dt className="text-xs text-text-muted">최종 수정일</dt><dd className="mt-0.5 text-sm text-text-primary">{formatDate(detail.updated_at)}</dd></div>
                    <div>
                      <dt className="text-xs text-text-muted">SSH 설정</dt>
                      <dd className="mt-0.5 text-sm text-text-primary">
                        {detail.ssh_configured
                          ? `${detail.ssh_user}@${detail.gateway_ip || "미설정"}:${detail.ssh_port}`
                          : "미설정"}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-text-muted">SSH 비밀번호</dt>
                      <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-primary">
                        {detail.ssh_configured ? (
                          <>
                            <span className="font-mono">
                              {revealedSshPassword ? revealedSshPassword : "••••••••••••"}
                            </span>
                            {revealedSshPassword ? (
                              <>
                                <button
                                  type="button"
                                  onClick={handleCopySshPassword}
                                  className="inline-flex items-center gap-1 rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
                                >
                                  <Copy className="w-3 h-3" />
                                  {passwordCopied ? "복사됨" : "복사"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRevealedSshPassword(null);
                                    setPasswordCopied(false);
                                  }}
                                  className="inline-flex items-center gap-1 rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
                                >
                                  <EyeOff className="w-3 h-3" />
                                  숨기기
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={handleRevealSshPassword}
                                disabled={isRevealingPassword}
                                className="inline-flex items-center gap-1 rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                              >
                                {isRevealingPassword ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                                {isRevealingPassword ? "조회 중..." : "일회성 조회"}
                              </button>
                            )}
                          </>
                        ) : (
                          <span>-</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block sm:col-span-2">
                      <span className="text-xs text-text-secondary">팀명</span>
                      <input type="text" value={editForm.name} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} placeholder="팀명" className={cn("mt-1", inputClass)} />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-secondary">VPN 대역</span>
                      <input type="text" value={editForm.subnet} onChange={(e) => setEditForm((p) => ({ ...p, subnet: e.target.value }))} placeholder="10.0.1.0/24" className={cn("mt-1", inputClass)} />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-secondary">팀 서버 IP</span>
                      <input type="text" value={editForm.gateway_ip} onChange={(e) => setEditForm((p) => ({ ...p, gateway_ip: e.target.value }))} placeholder="10.1.0.1" className={cn("mt-1", inputClass)} />
                    </label>
                    <label className="flex items-center gap-2 sm:col-span-2 cursor-pointer">
                      <input type="checkbox" checked={editForm.vpn_profile_issued} onChange={(e) => setEditForm((p) => ({ ...p, vpn_profile_issued: e.target.checked }))} className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-bg-tertiary" />
                      <span className="text-sm text-text-secondary">VPN 프로파일 발급 완료</span>
                    </label>
                    <div className="pt-3 border-t border-border sm:col-span-2">
                      <p className="text-xs font-medium text-text-muted mb-2">SSH 접속 정보</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-text-muted mb-1">SSH 포트</label>
                          <input type="number" value={editForm.ssh_port}
                            onChange={(e) => setEditForm((f) => ({ ...f, ssh_port: e.target.value }))}
                            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary"
                            min={1} max={65535} />
                        </div>
                        <div>
                          <label className="block text-xs text-text-muted mb-1">SSH 사용자</label>
                          <input type="text" value={editForm.ssh_user}
                            onChange={(e) => setEditForm((f) => ({ ...f, ssh_user: e.target.value }))}
                            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary"
                            placeholder="root" />
                        </div>
                      </div>
                      <div className="mt-2">
                        <label className="block text-xs text-text-muted mb-1">
                          SSH 비밀번호 {detail.ssh_configured && <span className="text-status-ok">(설정됨)</span>}
                        </label>
                        <input type="password" value={editForm.ssh_password}
                          onChange={(e) => setEditForm((f) => ({ ...f, ssh_password: e.target.value }))}
                          className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary"
                          placeholder={detail.ssh_configured ? "변경 시에만 입력" : "비밀번호"}
                          autoComplete="off" />
                      </div>
	                    </div>
	                  </div>
	                )}
                  </section>
                )}

                {activeTab === "members" && (
                  <section className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
                    <div className="px-5 py-4 flex items-center justify-between gap-3 border-b border-border">
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                          <Users className="w-4 h-4 text-text-muted" /> 팀원
                        </h3>
                        <p className="mt-1 text-xs text-text-muted">
                          팀원 초대와 현재 소속 상태를 관리합니다.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowAddMember(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        팀원 추가
                      </button>
                    </div>
	                {members.length > 0 ? (
	                  <table className="w-full text-sm">
	                    <thead>
	                      <tr className="text-left text-text-muted">
	                        <th className="px-5 py-2.5 font-medium">사용자</th>
	                        <th className="px-5 py-2.5 font-medium">역할</th>
	                        <th className="px-5 py-2.5 font-medium">상태</th>
                        <th className="px-5 py-2.5 font-medium">가입일</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => {
                        const mStatus = TEAM_MEMBER_STATUS_MAP[m.status] || { label: m.status, color: "neutral" as const };
                        return (
                          <tr key={m.id} className="border-t border-border last:border-b-0">
                            <td className="px-5 py-2.5 text-text-primary">
                              <span className="font-mono text-xs">{m.discord_username || m.discord_user_id}</span>
                            </td>
                            <td className="px-5 py-2.5 text-text-secondary">{TEAM_MEMBER_ROLE_MAP[m.role] || m.role}</td>
                            <td className="px-5 py-2.5"><StatusIndicator status={mStatus.color} label={mStatus.label} size="sm" /></td>
                            <td className="px-5 py-2.5 text-text-secondary">{formatDate(m.joined_at)}</td>
                          </tr>
                        );
                      })}
	                    </tbody>
	                  </table>
	                ) : (
	                  <p className="px-5 py-8 text-sm text-text-muted">등록된 팀원이 없습니다.</p>
	                )}
                  </section>
                )}

                {activeTab === "services" && (
                  <section className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
                    <div className="px-5 py-4 border-b border-border">
                      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                        <Server className="w-4 h-4 text-text-muted" /> 서비스
                      </h3>
                      <p className="mt-1 text-xs text-text-muted">
                        이 팀에 배포된 서비스와 최근 헬스체크 결과입니다.
                      </p>
                    </div>
	                {services.length > 0 ? (
	                  <table className="w-full text-sm">
	                    <thead>
	                      <tr className="text-left text-text-muted">
	                        <th className="px-5 py-2.5 font-medium">서비스</th>
	                        <th className="px-5 py-2.5 font-medium">호스트</th>
	                        <th className="px-5 py-2.5 font-medium">상태</th>
                        <th className="px-5 py-2.5 font-medium">헬스체크</th>
                      </tr>
                    </thead>
                    <tbody>
                      {services.map((svc) => (
                        <tr key={svc.id} className="border-t border-border last:border-b-0">
                          <td className="px-5 py-2.5 text-text-primary">{svc.service_name || svc.service_id}</td>
                          <td className="px-5 py-2.5 text-text-secondary font-mono text-xs">{svc.host_ip}:{svc.port}</td>
                          <td className="px-5 py-2.5">
                            <StatusIndicator
                              status={svc.status === "running" ? "ok" : svc.status === "stopped" ? "neutral" : "warning"}
                              label={svc.status}
                              size="sm"
                            />
                          </td>
                          <td className="px-5 py-2.5 text-text-secondary">
                            {svc.last_health_check_at ? (
                              <span className={cn("text-xs", svc.last_health_check_result ? "text-status-ok" : "text-status-danger")}>
                                {svc.last_health_check_result ? "정상" : "실패"} ({formatDate(svc.last_health_check_at)})
                              </span>
                            ) : (
                              <span className="text-xs text-text-muted">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
	                    </tbody>
	                  </table>
	                ) : (
	                  <p className="px-5 py-8 text-sm text-text-muted">배포된 서비스가 없습니다.</p>
	                )}
                  </section>
                )}

                {activeTab === "runtime" && (
                  <TeamRuntimeSection
                    teamId={teamId}
                    teamName={detail.name}
                    services={services}
                    embedded
                  />
                )}
	            </>
	          )}
	        </div>
      </div>

      {/* 승인 확인 모달 */}
      <ConfirmModal
        open={showApprove}
        onOpenChange={setShowApprove}
        title="팀을 승인하시겠습니까?"
        description={`"${detail?.name}" 팀이 승인되면 대회에 참가할 수 있습니다.`}
        confirmLabel="승인"
        variant="default"
        onConfirm={handleApprove}
        isLoading={isActioning}
      />

      {/* 실격 확인 모달 */}
      <ConfirmModal
        open={showDisqualify}
        onOpenChange={(open) => { if (!open) { setShowDisqualify(false); setDisqualifyReason(""); } }}
        title="팀을 실격 처리하시겠습니까?"
        description={`"${detail?.name}" 팀이 실격 처리되면 대회 참가가 중단됩니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="실격 처리"
        variant="danger"
        onConfirm={handleDisqualify}
        isLoading={isActioning}
      >
        <label className="block">
          <span className="text-sm text-text-secondary">실격 사유 *</span>
          <textarea
            value={disqualifyReason}
            onChange={(e) => setDisqualifyReason(e.target.value)}
            rows={2}
            className={cn("mt-1", inputClass)}
            placeholder="실격 사유를 입력하세요"
            required
          />
        </label>
      </ConfirmModal>

      {/* 삭제 확인 모달 */}
      <ConfirmModal
        open={showDelete}
        onOpenChange={setShowDelete}
        title="팀을 영구 삭제하시겠습니까?"
	        description={
	          detail?.status === "active"
	            ? `"${detail?.name}" 팀은 현재 활성 상태입니다. 삭제하면 팀원·점수·플래그·SLA 기록이 모두 함께 사라지며 되돌릴 수 없습니다. 배포된 컨테이너는 삭제 전에 [런타임] 섹션에서 상태를 확인하세요.`
	            : `"${detail?.name}" 팀과 관련된 모든 레코드(팀원, 점수, 플래그, SLA, 팀 서비스 매핑)가 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`
	        }
        confirmLabel="영구 삭제"
        variant="danger"
        onConfirm={handleDelete}
        isLoading={isActioning}
      />

      {showAddMember && detail && (
        <AddTeamMemberModal
          competitionId={competitionId}
          teamId={teamId}
          teamName={detail.name}
          onClose={() => setShowAddMember(false)}
          onAdded={async () => {
            await fetchAll();
            onMutated();
          }}
        />
      )}
    </>
  );
}

/* ── 대회 선택 드롭다운 ── */

function CompetitionSelector({
  competitions,
  selectedId,
  onChange,
}: {
  competitions: CompetitionListItem[];
  selectedId: string;
  onChange: (id: string) => void;
}) {
  if (competitions.length <= 1) return null;

  return (
    <div className="flex items-center gap-3">
      <label htmlFor="comp-select" className="text-sm text-text-secondary whitespace-nowrap">
        대회 선택
      </label>
      <select
        id="comp-select"
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent min-w-[200px]"
      >
        {competitions.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.status})
          </option>
        ))}
      </select>
    </div>
  );
}

/* ── 메인 페이지 ── */

export default function StandaloneTeamsPage() {
  /* 대회 목록 */
  const [competitions, setCompetitions] = useState<CompetitionListItem[]>([]);
  const [selectedCompId, setSelectedCompId] = useState<string | null>(null);
  const [isCompLoading, setIsCompLoading] = useState(true);
  const [compError, setCompError] = useState<string | null>(null);

  /* 팀 목록 */
  const [data, setData] = useState<TeamListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  /* 팀 생성 모달 */
  const [showCreate, setShowCreate] = useState(false);
  const [createAllocationMode, setCreateAllocationMode] = useState<"auto" | "manual">("auto");
  const [createForm, setCreateForm] = useState({
    name: "", subnet: "", gateway_ip: "",
    ssh_port: "22", ssh_user: "", ssh_password: "",
  });
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /* 대회 목록 조회 → 자동 선택 */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsCompLoading(true);
      setCompError(null);
      try {
        const res = await apiFetch<CompetitionListResponse>(
          "/v1/competitions/?page=1&size=100",
        );
        if (cancelled) return;
        setCompetitions(res.items);

        if (res.items.length > 0) {
          /* running 상태 우선, 없으면 첫 번째 */
          const running = res.items.find((c) => c.status === "running");
          setSelectedCompId(running ? running.id : res.items[0].id);
        }
      } catch (err) {
        if (cancelled) return;
        setCompError(err instanceof Error ? err.message : "대회 목록 조회에 실패했습니다.");
      } finally {
        if (!cancelled) setIsCompLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  /* 팀 목록 조회 */
  const fetchList = useCallback(async () => {
    if (!selectedCompId) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("size", String(PAGE_SIZE));
      const result = await apiFetch<TeamListResponse>(
        `/v1/competitions/${selectedCompId}/teams/?${params.toString()}`,
      );
      setData(result);
    } catch {
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [selectedCompId, statusFilter, page]);

  useEffect(() => { fetchList(); }, [fetchList]);

  /* 대회 변경 시 필터/페이지 초기화 */
  function handleCompChange(id: string) {
    setSelectedCompId(id);
    setStatusFilter("all");
    setPage(1);
    setSelectedTeamId(null);
  }

  function handleTabChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  async function handleCreateTeam() {
    if (!selectedCompId || !createForm.name.trim()) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const body: Record<string, unknown> = { name: createForm.name.trim() };
      if (createAllocationMode === "manual") {
        if (createForm.subnet.trim()) body.subnet = createForm.subnet.trim();
        if (createForm.gateway_ip.trim()) body.gateway_ip = createForm.gateway_ip.trim();
        const port = parseInt(createForm.ssh_port, 10);
        if (!isNaN(port) && port > 0) body.ssh_port = port;
        if (createForm.ssh_user.trim()) body.ssh_user = createForm.ssh_user.trim();
        if (createForm.ssh_password) body.ssh_password = createForm.ssh_password;
      }

      await apiFetch(`/v1/competitions/${selectedCompId}/teams/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setShowCreate(false);
      setCreateAllocationMode("auto");
      setCreateForm({ name: "", subnet: "", gateway_ip: "", ssh_port: "22", ssh_user: "", ssh_password: "" });
      fetchList();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "팀 생성에 실패했습니다.");
    } finally {
      setIsCreating(false);
    }
  }

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  /* ── 대회 로딩 중 ── */
  if (isCompLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="팀 관리" description="대회별 팀 목록 조회 및 관리" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      </div>
    );
  }

  /* ── 대회 로드 실패 ── */
  if (compError) {
    return (
      <div className="space-y-6">
        <PageHeader title="팀 관리" description="대회별 팀 목록 조회 및 관리" />
        <div className="rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
          {compError}
        </div>
      </div>
    );
  }

  /* ── 대회 없음 ── */
  if (competitions.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="팀 관리" description="대회별 팀 목록 조회 및 관리" />
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <Users className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">등록된 대회가 없습니다. 먼저 대회를 생성하세요.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="팀 관리"
        description="대회별 팀 목록 조회 및 관리"
        actions={
          <div className="flex items-center gap-3">
            <CompetitionSelector
              competitions={competitions}
              selectedId={selectedCompId!}
              onChange={handleCompChange}
            />
            {selectedCompId && (
              <button
                type="button"
                onClick={() => {
                  setCreateError(null);
                  setCreateAllocationMode("auto");
                  setCreateForm({ name: "", subnet: "", gateway_ip: "", ssh_port: "22", ssh_user: "", ssh_password: "" });
                  setShowCreate(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                <Plus className="w-4 h-4" />
                팀 생성
              </button>
            )}
          </div>
        }
      />

      {/* 상태 필터 탭 */}
      <div className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => handleTabChange(tab.value)}
            className={cn(
              "px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
              statusFilter === tab.value
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 로딩 */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      )}

      {/* 빈 상태 */}
      {!isLoading && data && data.items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <Users className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">등록된 팀이 없습니다.</p>
        </div>
      )}

      {/* 팀 목록 테이블 */}
      {!isLoading && data && data.items.length > 0 && (
        <div className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-4 py-3 font-medium">팀명</th>
                <th className="px-4 py-3 font-medium">팀 코드</th>
                <th className="px-4 py-3 font-medium">상태</th>
                <th className="px-4 py-3 font-medium">인원</th>
                <th className="px-4 py-3 font-medium">VPN 대역</th>
                <th className="px-4 py-3 font-medium">VPN</th>
                <th className="px-4 py-3 font-medium">SSH</th>
                <th className="px-4 py-3 font-medium">등록일</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((team) => {
                const tStatus = TEAM_STATUS_MAP[team.status] || { label: team.status, color: "neutral" as const };
                return (
                  <tr
                    key={team.id}
                    onClick={() => setSelectedTeamId(team.id)}
                    className="border-b border-border last:border-b-0 hover:bg-bg-tertiary cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-text-primary">{team.name}</td>
                    <td className="px-4 py-3 text-text-secondary font-mono text-xs">{team.team_code}</td>
                    <td className="px-4 py-3"><StatusIndicator status={tStatus.color} label={tStatus.label} size="sm" /></td>
                    <td className="px-4 py-3 text-text-secondary">{team.member_count}명</td>
                    <td className="px-4 py-3 text-text-secondary font-mono text-xs">{team.subnet || "-"}</td>
                    <td className="px-4 py-3">
                      <Globe className={cn("w-4 h-4", team.vpn_profile_issued ? "text-status-ok" : "text-text-muted opacity-40")} />
                    </td>
                    <td className="px-4 py-3">
                      <Server className={cn("w-4 h-4", team.ssh_configured ? "text-status-ok" : "text-text-muted opacity-40")} />
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(team.registered_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 페이지네이션 */}
      {!isLoading && data && totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
          >
            이전
          </button>
          <span className="px-3 py-1.5 text-sm text-text-muted">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
          >
            다음
          </button>
        </div>
      )}

      {/* 팀 상세 드로어 */}
      {selectedTeamId && selectedCompId && (
        <TeamDrawer
          competitionId={selectedCompId}
          teamId={selectedTeamId}
          onClose={() => setSelectedTeamId(null)}
          onMutated={fetchList}
        />
      )}

      {/* 팀 생성 모달 */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg-secondary rounded-xl border border-border p-6 w-full max-w-md shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-text-primary">팀 생성</h3>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setCreateAllocationMode("auto");
                }}
                className="text-text-muted hover:text-text-primary"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {createError && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {createError}
              </div>
            )}

            <div className="space-y-4">
              <label className="block">
                <span className="text-sm text-text-secondary">팀명 <span className="text-red-400">*</span></span>
                <input
                  type="text"
                  value={createForm.name}
                  onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="팀 이름을 입력하세요"
                  className="mt-1 block w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                  maxLength={100}
                />
              </label>

              <label className="block">
                <span className="text-sm text-text-secondary">VPN 대역 선택</span>
                <select
                  value={createAllocationMode}
                  onChange={(e) => setCreateAllocationMode(e.target.value as "auto" | "manual")}
                  className="mt-1 block w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {CREATE_ALLOCATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {createAllocationMode === "auto" ? (
                <p className="text-xs text-text-muted -mt-2">
                  빈 슬롯이 있으면 VPN 대역, 팀 서버 IP, SSH 정보를 자동으로 배정합니다.
                </p>
              ) : (
                <>
                  <label className="block">
                    <span className="text-sm text-text-secondary">VPN 대역</span>
                    <input
                      type="text"
                      value={createForm.subnet}
                      onChange={(e) => setCreateForm((p) => ({ ...p, subnet: e.target.value }))}
                      placeholder="예: 10.88.3.0/24"
                      className="mt-1 block w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm text-text-secondary">팀 서버 IP</span>
                    <input
                      type="text"
                      value={createForm.gateway_ip}
                      onChange={(e) => setCreateForm((p) => ({ ...p, gateway_ip: e.target.value }))}
                      placeholder="예: 10.2.3.10"
                      className="mt-1 block w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                  </label>

                  {/* SSH 접속 정보 */}
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs font-medium text-text-muted mb-2">SSH 접속 정보</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-text-muted mb-1">SSH 포트</label>
                        <input
                          type="number"
                          value={createForm.ssh_port}
                          onChange={(e) => setCreateForm((f) => ({ ...f, ssh_port: e.target.value }))}
                          className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary"
                          placeholder="22"
                          min={1}
                          max={65535}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-text-muted mb-1">SSH 사용자</label>
                        <input
                          type="text"
                          value={createForm.ssh_user}
                          onChange={(e) => setCreateForm((f) => ({ ...f, ssh_user: e.target.value }))}
                          className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary"
                          placeholder="user"
                        />
                      </div>
                    </div>
                    <div className="mt-2">
                      <label className="block text-xs text-text-muted mb-1">SSH 비밀번호</label>
                      <input
                        type="password"
                        value={createForm.ssh_password}
                        onChange={(e) => setCreateForm((f) => ({ ...f, ssh_password: e.target.value }))}
                        className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary"
                        placeholder="비밀번호"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setCreateAllocationMode("auto");
                }}
                className="px-4 py-2 text-sm rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleCreateTeam}
                disabled={isCreating || !createForm.name.trim()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {isCreating ? "생성 중..." : "생성"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
