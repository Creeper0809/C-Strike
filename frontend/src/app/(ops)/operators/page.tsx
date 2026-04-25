"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Shield,
  Loader2,
  RefreshCw,
  UserCog,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/AuthProvider";
import PageHeader from "@/components/ui/PageHeader";
import { CGUARD_SESSION_STATUS_MAP, STATUS_COLORS } from "@/lib/constants";
import type {
  CGuardSession,
  CompetitionListResponse,
  DiscordDirectoryMemberItem,
  DiscordDirectoryMemberListResponse,
  DiscordDirectorySyncResponse,
  Operator,
  OperatorCreateResponse,
  OperatorUpdatePayload,
} from "@/types/ops";

type AccessLevel = "none" | "operator" | "admin";
type PortalStatusFilter = "all" | "none" | "active" | "inactive";
type TeamAssignmentFilter = "all" | "assigned" | "unassigned";
type CGuardStatusFilter = "all" | "none" | "ACTIVE" | "RESTRICTED" | "BLOCKED" | "OFFLINE";

interface GeneratedPasswordState {
  displayName: string;
  role: "operator" | "admin";
  username: string | null;
  password: string;
}

const INPUT_CLASS =
  "mt-1 block w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent";

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

function maskDiscordId(discordId: string): string {
  if (discordId.length <= 8) return discordId;
  return `${discordId.slice(0, 4)}…${discordId.slice(-4)}`;
}

function getEffectiveRole(operator: Operator | undefined): AccessLevel {
  if (!operator || !operator.is_active) return "none";
  return operator.role;
}

function getPortalStatus(operator: Operator | undefined): {
  label: string;
  className: string;
} {
  if (!operator) {
    return {
      label: "미생성",
      className: "text-text-muted bg-bg-tertiary",
    };
  }

  if (operator.is_active) {
    return {
      label: "활성",
      className: "text-status-ok bg-status-ok/10",
    };
  }

  return {
    label: "비활성",
    className: "text-status-warning bg-status-warning/10",
  };
}

function getRoleLabel(role: AccessLevel): string {
  switch (role) {
    case "admin":
      return "관리자";
    case "operator":
      return "운영자";
    default:
      return "일반 유저";
  }
}

function formatCGuardStatus(value: string | null): {
  label: string;
  className: string;
} {
  if (!value) {
    return {
      label: "미연결",
      className: "text-text-muted bg-bg-tertiary",
    };
  }

  const entry = CGUARD_SESSION_STATUS_MAP[value];
  if (!entry) {
    return {
      label: value,
      className: "text-text-muted bg-bg-tertiary",
    };
  }

  return {
    label: entry.label,
    className: cn(
      STATUS_COLORS[entry.color],
      entry.color === "ok" && "bg-status-ok/10",
      entry.color === "warning" && "bg-status-warning/10",
      entry.color === "danger" && "bg-status-danger/10",
      entry.color === "info" && "bg-status-info/10",
      entry.color === "neutral" && "bg-bg-tertiary",
    ),
  };
}

function GeneratedPasswordModal({
  state,
  onClose,
}: {
  state: GeneratedPasswordState;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(state.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 수동 복사 가능
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-bg-secondary rounded-xl border border-border p-6 w-full max-w-md shadow-xl">
        <div className="flex items-center gap-2 mb-5">
          <UserCog className="w-4 h-4 text-accent" />
          <h3 className="text-lg font-semibold text-text-primary">
            유저 권한 부여 완료
          </h3>
        </div>

        <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
            <p className="text-sm text-status-warning leading-relaxed">
              {state.displayName} 님에게 {getRoleLabel(state.role)} 권한을 부여하면서
              운영포털 로그인 계정도 함께 생성했어.
              <br />
              <span className="text-xs text-status-warning/80">
                초기 비밀번호는 지금 한 번만 보여줘. 닫기 전에 꼭 복사해야 해.
              </span>
            </p>
          </div>

          {state.username && (
            <div className="space-y-1">
              <span className="text-xs text-text-muted">사용자명</span>
              <div className="font-mono text-sm text-text-primary px-3 py-2 bg-bg-tertiary rounded-lg border border-border break-all">
                {state.username}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <span className="text-xs text-text-muted">초기 비밀번호</span>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 font-mono text-sm text-text-primary px-3 py-2 bg-bg-tertiary rounded-lg border border-border break-all select-all">
                {state.password}
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap",
                  copied
                    ? "bg-status-ok/15 text-status-ok border border-status-ok/40"
                    : "bg-accent text-white hover:bg-accent/90",
                )}
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

        <div className="flex justify-end mt-6">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OperatorsPage() {
  const { operator: me } = useAuth();
  const [members, setMembers] = useState<DiscordDirectoryMemberItem[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [cguardSessions, setCguardSessions] = useState<CGuardSession[]>([]);
  const [selectedCompetitionId, setSelectedCompetitionId] = useState<string | null>(null);
  const [selectedCompetitionName, setSelectedCompetitionName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [rowLoadingId, setRowLoadingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<AccessLevel | "all">("all");
  const [portalStatusFilter, setPortalStatusFilter] =
    useState<PortalStatusFilter>("all");
  const [teamAssignmentFilter, setTeamAssignmentFilter] =
    useState<TeamAssignmentFilter>("all");
  const [cguardStatusFilter, setCguardStatusFilter] =
    useState<CGuardStatusFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [generatedPassword, setGeneratedPassword] =
    useState<GeneratedPasswordState | null>(null);

  const canManageRoles = me?.role === "admin";

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const competitions = await apiFetch<CompetitionListResponse>(
        "/v1/competitions/?page=1&size=100",
      );
      const runningCompetition = competitions.items.find(
        (competition) => competition.status === "running",
      );
      const effectiveCompetition =
        runningCompetition ?? competitions.items[0] ?? null;
      const effectiveCompetitionId = effectiveCompetition?.id ?? null;

      const directoryParams = new URLSearchParams({
        limit: "500",
      });
      if (effectiveCompetitionId) {
        directoryParams.set("competition_id", effectiveCompetitionId);
      }

      const [directoryRaw, operatorsRaw, cguardRaw] = await Promise.all([
        apiFetch<DiscordDirectoryMemberListResponse>(
          `/discord-directory/members?${directoryParams.toString()}`,
        ),
        apiFetch<Operator[] | { items: Operator[] }>("/operators"),
        apiFetch<{ items: CGuardSession[]; total: number }>(
          "/cguard/sessions?page=1&size=100",
        ).catch(() => ({ items: [], total: 0 })),
      ]);
      const operatorItems = Array.isArray(operatorsRaw)
        ? operatorsRaw
        : (operatorsRaw.items ?? []);
      setSelectedCompetitionId(effectiveCompetitionId);
      setSelectedCompetitionName(effectiveCompetition?.name ?? null);
      setMembers(directoryRaw.items);
      setOperators(operatorItems);
      setCguardSessions(cguardRaw.items ?? []);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "유저 목록을 불러오지 못했습니다.",
      );
      setSelectedCompetitionId(null);
      setSelectedCompetitionName(null);
      setMembers([]);
      setOperators([]);
      setCguardSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const operatorsByDiscordId = useMemo(() => {
    const map = new Map<string, Operator>();
    for (const operator of operators) {
      if (operator.discord_user_id) {
        map.set(operator.discord_user_id, operator);
      }
    }
    return map;
  }, [operators]);

  const cguardSessionsByUsername = useMemo(() => {
    const map = new Map<string, CGuardSession>();
    for (const session of cguardSessions) {
      if (!session.username) continue;
      const key = session.username.trim().toLowerCase();
      if (!key || map.has(key)) continue;
      map.set(key, session);
    }
    return map;
  }, [cguardSessions]);

  function resolveCGuardSession(member: DiscordDirectoryMemberItem) {
    const keys = [
      member.username,
      member.nick,
      member.global_name,
      member.display_name,
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);

    for (const key of keys) {
      const matched = cguardSessionsByUsername.get(key);
      if (matched) return matched;
    }
    return undefined;
  }

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((member) => {
      const linkedOperator = operatorsByDiscordId.get(member.discord_user_id);
      const effectiveRole = getEffectiveRole(linkedOperator);
      const hasAssignedTeam = Boolean(member.assigned_team_name);
      const cguardSession = resolveCGuardSession(member);

      if (q) {
        const matched = [
          member.display_name,
          member.username,
          member.global_name,
          member.nick,
          member.discord_user_id,
          member.assigned_team_name,
        ].some((value) => String(value || "").toLowerCase().includes(q));
        if (!matched) return false;
      }

      if (roleFilter !== "all" && effectiveRole !== roleFilter) {
        return false;
      }

      if (portalStatusFilter === "none" && linkedOperator) {
        return false;
      }
      if (portalStatusFilter === "active" && !linkedOperator?.is_active) {
        return false;
      }
      if (
        portalStatusFilter === "inactive" &&
        (!linkedOperator || linkedOperator.is_active)
      ) {
        return false;
      }

      if (teamAssignmentFilter === "assigned" && !hasAssignedTeam) {
        return false;
      }
      if (teamAssignmentFilter === "unassigned" && hasAssignedTeam) {
        return false;
      }

      if (cguardStatusFilter === "none" && cguardSession) {
        return false;
      }

      if (
        cguardStatusFilter !== "all" &&
        cguardStatusFilter !== "none" &&
        cguardSession?.status !== cguardStatusFilter
      ) {
        return false;
      }

      if (
        cguardStatusFilter !== "all" &&
        cguardStatusFilter !== "none" &&
        !cguardSession
      ) {
        return false;
      }

      return true;
    });
  }, [
    cguardSessionsByUsername,
    cguardStatusFilter,
    members,
    operatorsByDiscordId,
    portalStatusFilter,
    roleFilter,
    search,
    teamAssignmentFilter,
  ]);

  const summary = useMemo(() => {
    let admins = 0;
    let operatorsCount = 0;
    let activePortalAccounts = 0;

    for (const member of members) {
      const linked = operatorsByDiscordId.get(member.discord_user_id);
      if (!linked || !linked.is_active) continue;
      activePortalAccounts += 1;
      if (linked.role === "admin") admins += 1;
      if (linked.role === "operator") operatorsCount += 1;
    }

    return {
      totalUsers: members.length,
      activePortalAccounts,
      admins,
      operators: operatorsCount,
    };
  }, [members, operatorsByDiscordId]);

  async function handleSyncDirectory() {
    setIsSyncing(true);
    setError(null);
    try {
      await apiFetch<DiscordDirectorySyncResponse>("/discord-directory/sync", {
        method: "POST",
      });
      await fetchData();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "디스코드 멤버 동기화에 실패했습니다.",
      );
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleRoleChange(
    member: DiscordDirectoryMemberItem,
    nextRole: AccessLevel,
  ) {
    if (!canManageRoles) return;

    const linkedOperator = operatorsByDiscordId.get(member.discord_user_id);
    const currentRole = getEffectiveRole(linkedOperator);

    if (currentRole === nextRole) {
      return;
    }

    if (linkedOperator && me?.id === linkedOperator.id) {
      setError("자기 자신의 권한은 이 화면에서 변경하지 않도록 막아뒀어.");
      return;
    }

    setRowLoadingId(member.discord_user_id);
    setError(null);

    try {
      if (!linkedOperator) {
        if (nextRole === "none") return;

        const response = await apiFetch<OperatorCreateResponse>("/operators", {
          method: "POST",
          body: JSON.stringify({
            discord_user_id: member.discord_user_id,
            display_name: member.display_name,
            role: nextRole,
          }),
        });

        if (response.generated_password) {
          setGeneratedPassword({
            displayName: member.display_name,
            role: nextRole,
            username: response.username ?? null,
            password: response.generated_password,
          });
        }
      } else if (nextRole === "none") {
        if (linkedOperator.is_active) {
          await apiFetch(`/operators/${linkedOperator.id}`, {
            method: "PATCH",
            body: JSON.stringify({ is_active: false }),
          });
        }
      } else {
        const body: OperatorUpdatePayload = {
          role: nextRole,
          is_active: true,
        };
        await apiFetch(`/operators/${linkedOperator.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }

      await fetchData();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "권한 변경에 실패했습니다.",
      );
    } finally {
      setRowLoadingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="유저 관리"
        description="디스코드 서버 유저를 기준으로 운영포털 권한을 부여하고 관리"
        actions={
          <button
            type="button"
            onClick={handleSyncDirectory}
            disabled={isSyncing}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {isSyncing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {isSyncing ? "동기화 중..." : "디스코드 동기화"}
          </button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-bg-secondary border border-border rounded-xl p-4">
          <p className="text-xs text-text-muted">디스코드 유저</p>
          <p className="mt-1 text-2xl font-semibold text-text-primary">
            {summary.totalUsers}
          </p>
        </div>
        <div className="bg-bg-secondary border border-border rounded-xl p-4">
          <p className="text-xs text-text-muted">포털 계정 활성</p>
          <p className="mt-1 text-2xl font-semibold text-status-ok">
            {summary.activePortalAccounts}
          </p>
        </div>
        <div className="bg-bg-secondary border border-border rounded-xl p-4">
          <p className="text-xs text-text-muted">운영자</p>
          <p className="mt-1 text-2xl font-semibold text-status-info">
            {summary.operators}
          </p>
        </div>
        <div className="bg-bg-secondary border border-border rounded-xl p-4">
          <p className="text-xs text-text-muted">관리자</p>
          <p className="mt-1 text-2xl font-semibold text-status-danger">
            {summary.admins}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-status-danger/10 border border-status-danger/30 px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      <div className="bg-bg-secondary border border-border rounded-xl p-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <label className="block">
            <span className="text-sm text-text-secondary">
              이름, 사용자명, Discord ID, 팀명 검색
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="예: opsBot, A Team, 1465..."
              className={INPUT_CLASS}
              autoComplete="off"
            />
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">권한</span>
            <select
              value={roleFilter}
              onChange={(e) =>
                setRoleFilter(e.target.value as AccessLevel | "all")
              }
              className={INPUT_CLASS}
            >
              <option value="all">전체</option>
              <option value="none">일반 유저</option>
              <option value="operator">운영자</option>
              <option value="admin">관리자</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">포털 계정 상태</span>
            <select
              value={portalStatusFilter}
              onChange={(e) =>
                setPortalStatusFilter(e.target.value as PortalStatusFilter)
              }
              className={INPUT_CLASS}
            >
              <option value="all">전체</option>
              <option value="none">미생성</option>
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">팀 배정</span>
            <select
              value={teamAssignmentFilter}
              onChange={(e) =>
                setTeamAssignmentFilter(e.target.value as TeamAssignmentFilter)
              }
              className={INPUT_CLASS}
            >
              <option value="all">전체</option>
              <option value="assigned">배정됨</option>
              <option value="unassigned">미배정</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm text-text-secondary">C-Guard 상태</span>
            <select
              value={cguardStatusFilter}
              onChange={(e) =>
                setCguardStatusFilter(e.target.value as CGuardStatusFilter)
              }
              className={INPUT_CLASS}
            >
              <option value="all">전체</option>
              <option value="none">미연결</option>
              <option value="ACTIVE">활성</option>
              <option value="RESTRICTED">제한</option>
              <option value="BLOCKED">차단</option>
              <option value="OFFLINE">오프라인</option>
            </select>
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
          <div className="space-y-1">
            <span>
              표시 중: {filteredMembers.length} / {members.length}
            </span>
            <div>
              팀 배정 기준 대회: {selectedCompetitionName ?? (selectedCompetitionId ? "선택됨" : "없음")}
            </div>
          </div>
          {(search ||
            roleFilter !== "all" ||
            portalStatusFilter !== "all" ||
            teamAssignmentFilter !== "all" ||
            cguardStatusFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setRoleFilter("all");
                setPortalStatusFilter("all");
                setTeamAssignmentFilter("all");
                setCguardStatusFilter("all");
              }}
              className="px-3 py-1.5 rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
            >
              필터 초기화
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      ) : filteredMembers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <UserCog className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">표시할 디스코드 유저가 없습니다.</p>
        </div>
      ) : (
        <div className="w-full overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-bg-tertiary">
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  유저
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  Discord
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  팀 배정
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  포털 계정
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  상태
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  C-Guard
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  최근 접속
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                  권한
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredMembers.map((member) => {
                const linkedOperator = operatorsByDiscordId.get(
                  member.discord_user_id,
                );
                const currentRole = getEffectiveRole(linkedOperator);
                const portalStatus = getPortalStatus(linkedOperator);
                const cguardSession = resolveCGuardSession(member);
                const cguardStatus = formatCGuardStatus(cguardSession?.status ?? null);
                const isSelf = linkedOperator?.id === me?.id;
                const isBusy = rowLoadingId === member.discord_user_id;
                const teamInfo = member.assigned_team_name
                  ? `${member.assigned_team_name} (${member.assigned_member_role === "captain" ? "팀장" : "팀원"})`
                  : "-";

                return (
                  <tr
                    key={member.discord_user_id}
                    className="transition-colors hover:bg-bg-tertiary/40"
                  >
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-text-primary">
                        {member.display_name}
                        {isSelf && (
                          <span className="ml-2 text-[10px] text-accent uppercase tracking-wider">
                            (나)
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-text-muted">
                        @{member.username}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-mono text-text-secondary">
                        {maskDiscordId(member.discord_user_id)}
                      </div>
                      <div className="mt-0.5 text-xs text-text-muted font-mono">
                        {member.discord_user_id}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {teamInfo}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-mono text-text-primary">
                        {linkedOperator?.username ?? "-"}
                      </div>
                      {linkedOperator && !linkedOperator.is_active && (
                        <div className="mt-0.5 text-xs text-text-muted">
                          비활성 계정 보유
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
                          portalStatus.className,
                        )}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                        {portalStatus.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div
                        className={cn(
                          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
                          cguardStatus.className,
                        )}
                      >
                        <Shield className="w-3 h-3" />
                        {cguardStatus.label}
                      </div>
                      <div className="mt-1 text-xs text-text-muted font-mono">
                        {cguardSession?.risk_score !== null && cguardSession?.risk_score !== undefined
                          ? `risk ${cguardSession.risk_score}`
                          : cguardSession?.decision_status ?? "-"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      <div className="font-mono whitespace-nowrap">
                        {cguardSession?.last_ip ?? "-"}
                      </div>
                      <div className="mt-0.5 text-xs font-mono text-text-muted whitespace-nowrap">
                        C-Guard {formatDateTime(cguardSession?.last_heartbeat_at ?? null)}
                      </div>
                      <div className="mt-0.5 text-xs font-mono text-text-muted whitespace-nowrap">
                        포털 {formatDateTime(linkedOperator?.last_login_at ?? null)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <select
                          value={currentRole}
                          disabled={!canManageRoles || isBusy || isSelf}
                          onChange={(e) =>
                            void handleRoleChange(
                              member,
                              e.target.value as AccessLevel,
                            )
                          }
                          className={cn(
                            "px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-1 focus:ring-accent",
                            (!canManageRoles || isSelf) &&
                              "opacity-50 cursor-not-allowed",
                          )}
                        >
                          <option value="none">일반 유저</option>
                          <option value="operator">운영자</option>
                          <option value="admin">관리자</option>
                        </select>
                        {isBusy && (
                          <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {generatedPassword && (
        <GeneratedPasswordModal
          state={generatedPassword}
          onClose={() => setGeneratedPassword(null)}
        />
      )}
    </div>
  );
}
