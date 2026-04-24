"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, Loader2, Users, CheckCircle, XOctagon,
  X, Shield, Globe, Server, ChevronDown, ChevronUp, Save,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  TEAM_STATUS_MAP,
  TEAM_MEMBER_ROLE_MAP,
  TEAM_MEMBER_STATUS_MAP,
} from "@/lib/constants";
import PageHeader from "@/components/ui/PageHeader";
import StatusIndicator from "@/components/ui/StatusIndicator";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type {
  TeamListItem,
  TeamListResponse,
  TeamDetail,
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
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [members, setMembers] = useState<TeamMemberItem[]>([]);
  const [services, setServices] = useState<TeamServiceItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* 승인 / 실격 모달 */
  const [showApprove, setShowApprove] = useState(false);
  const [showDisqualify, setShowDisqualify] = useState(false);
  const [disqualifyReason, setDisqualifyReason] = useState("");
  const [isActioning, setIsActioning] = useState(false);

  /* 수정 모드 */
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ subnet: "", gateway_ip: "", vpn_profile_issued: false });
  const [isSaving, setIsSaving] = useState(false);

  /* 섹션 접기 */
  const [showMembers, setShowMembers] = useState(true);
  const [showServices, setShowServices] = useState(true);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [d, m, s] = await Promise.all([
        apiFetch<TeamDetail>(`/v1/competitions/${competitionId}/teams/${teamId}`),
        apiFetch<TeamMemberItem[]>(`/v1/competitions/${competitionId}/teams/${teamId}/members`),
        apiFetch<TeamServiceItem[]>(`/v1/competitions/${competitionId}/teams/${teamId}/services`),
      ]);
      setDetail(d);
      setMembers(m);
      setServices(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "팀 정보 조회에 실패했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, teamId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function startEditing() {
    if (!detail) return;
    setEditForm({
      subnet: detail.subnet || "",
      gateway_ip: detail.gateway_ip || "",
      vpn_profile_issued: detail.vpn_profile_issued,
    });
    setIsEditing(true);
  }

  async function handleSave() {
    if (!detail) return;
    setIsSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      const newSubnet = editForm.subnet.trim() || null;
      const newGateway = editForm.gateway_ip.trim() || null;
      if (newSubnet !== detail.subnet) body.subnet = newSubnet;
      if (newGateway !== detail.gateway_ip) body.gateway_ip = newGateway;
      if (editForm.vpn_profile_issued !== detail.vpn_profile_issued) body.vpn_profile_issued = editForm.vpn_profile_issued;
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
                </div>
              </div>

              {/* 팀 기본 정보 */}
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
                  </dl>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-xs text-text-secondary">VPN 대역</span>
                      <input type="text" value={editForm.subnet} onChange={(e) => setEditForm((p) => ({ ...p, subnet: e.target.value }))} placeholder="10.0.1.0/24" className={cn("mt-1", inputClass)} />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-secondary">팀 서버 IP</span>
                      <input type="text" value={editForm.gateway_ip} onChange={(e) => setEditForm((p) => ({ ...p, gateway_ip: e.target.value }))} placeholder="10.0.1.1" className={cn("mt-1", inputClass)} />
                    </label>
                    <label className="flex items-center gap-2 sm:col-span-2 cursor-pointer">
                      <input type="checkbox" checked={editForm.vpn_profile_issued} onChange={(e) => setEditForm((p) => ({ ...p, vpn_profile_issued: e.target.checked }))} className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-bg-tertiary" />
                      <span className="text-sm text-text-secondary">VPN 프로파일 발급 완료</span>
                    </label>
                  </div>
                )}
              </section>

              {/* 팀원 목록 */}
              <section className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
                <button onClick={() => setShowMembers((v) => !v)} className="w-full flex items-center justify-between px-5 py-4 text-left">
                  <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                    <Users className="w-4 h-4 text-text-muted" /> 팀원
                    <span className="ml-1 text-xs font-normal text-text-muted">({members.length}명)</span>
                  </h3>
                  {showMembers ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
                </button>
                {showMembers && members.length > 0 && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-border text-left text-text-muted">
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
                )}
                {showMembers && members.length === 0 && (
                  <p className="px-5 pb-4 text-sm text-text-muted">등록된 팀원이 없습니다.</p>
                )}
              </section>

              {/* 서비스 목록 */}
              <section className="bg-bg-secondary rounded-xl border border-border overflow-hidden">
                <button onClick={() => setShowServices((v) => !v)} className="w-full flex items-center justify-between px-5 py-4 text-left">
                  <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                    <Server className="w-4 h-4 text-text-muted" /> 서비스
                    <span className="ml-1 text-xs font-normal text-text-muted">({services.length}개)</span>
                  </h3>
                  {showServices ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
                </button>
                {showServices && services.length > 0 && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-border text-left text-text-muted">
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
                )}
                {showServices && services.length === 0 && (
                  <p className="px-5 pb-4 text-sm text-text-muted">배포된 서비스가 없습니다.</p>
                )}
              </section>
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
    </>
  );
}

/* ── 메인 페이지 ── */

export default function TeamsPage() {
  const params = useParams();
  const router = useRouter();
  const competitionId = params.id as string;

  const [data, setData] = useState<TeamListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("size", String(PAGE_SIZE));
      const result = await apiFetch<TeamListResponse>(
        `/v1/competitions/${competitionId}/teams/?${params.toString()}`,
      );
      setData(result);
    } catch {
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, statusFilter, page]);

  useEffect(() => { fetchList(); }, [fetchList]);

  function handleTabChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.push(`/competitions/${competitionId}`)}
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> 대회 상세로
      </button>

      <PageHeader
        title="팀 관리"
        description="대회에 등록된 팀 목록 조회 및 관리"
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
      {selectedTeamId && (
        <TeamDrawer
          competitionId={competitionId}
          teamId={selectedTeamId}
          onClose={() => setSelectedTeamId(null)}
          onMutated={fetchList}
        />
      )}
    </div>
  );
}
