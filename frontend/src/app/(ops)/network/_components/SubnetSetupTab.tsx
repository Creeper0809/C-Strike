"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Globe,
  CheckCircle,
  AlertTriangle,
  Shield,
  Pencil,
  Plus,
  Wand2,
  RefreshCw,
  Loader2,
  Network,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import ConfirmModal from "@/components/ui/ConfirmModal";
import SubnetEditModal from "./SubnetEditModal";
import type {
  TeamSubnetInfo,
  SubnetListResponse,
  SubnetAutoAssignResponse,
} from "@/types/ops";

/* ─── Props ──────────────────────────────────────────── */

interface SubnetSetupTabProps {
  competitionId: string;
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
  color: "default" | "ok" | "warning" | "teal";
}) {
  const colorMap = {
    default: "text-text-primary",
    ok: "text-status-ok",
    warning: "text-amber-400",
    teal: "text-teal-400",
  };
  const iconColorMap = {
    default: "text-accent",
    ok: "text-status-ok",
    warning: "text-amber-400",
    teal: "text-teal-400",
  };
  const bgMap = {
    default: "bg-accent/10",
    ok: "bg-status-ok/10",
    warning: "bg-amber-400/10",
    teal: "bg-teal-400/10",
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

export default function SubnetSetupTab({ competitionId }: SubnetSetupTabProps) {
  /* 상태 */
  const [data, setData] = useState<SubnetListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* 모달: 서브넷 편집 */
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TeamSubnetInfo | null>(null);

  /* 모달: 자동 할당 확인 */
  const [autoAssignOpen, setAutoAssignOpen] = useState(false);
  const [autoAssignLoading, setAutoAssignLoading] = useState(false);

  /* ── 데이터 조회 ─────────────────────────────────── */

  const fetchSubnets = useCallback(async () => {
    if (!competitionId) return;

    try {
      const res = await apiFetch<SubnetListResponse>(
        `/v1/competitions/${competitionId}/network/subnets`,
      );
      setData(res);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "VPN 대역 목록을 불러올 수 없습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, [competitionId]);

  useEffect(() => {
    fetchSubnets();
  }, [fetchSubnets]);

  /* ── 자동 할당 ───────────────────────────────────── */

  async function handleAutoAssign() {
    if (!competitionId) return;

    setAutoAssignLoading(true);
    try {
      await apiFetch<SubnetAutoAssignResponse>(
        `/v1/competitions/${competitionId}/network/subnets/auto-assign`,
        {
          method: "POST",
          body: JSON.stringify({ base_prefix: "10.10", start_index: 1 }),
        },
      );
      setAutoAssignOpen(false);
      await fetchSubnets();
    } catch {
      // 모달이 닫히지 않으므로 사용자가 재시도 가능
    } finally {
      setAutoAssignLoading(false);
    }
  }

  /* ── 편집 모달 열기 ──────────────────────────────── */

  function openEditModal(team: TeamSubnetInfo) {
    setEditTarget(team);
    setEditModalOpen(true);
  }

  /* ── 로딩 상태 ───────────────────────────────────── */

  if (loading) {
    return (
      <div className="space-y-6">
        {/* 개요 카드 스켈레톤 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
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
            fetchSubnets();
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

  /* ── 렌더링 ──────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* ── 1. 요약 카드 4열 ───────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <OverviewCard
          label="전체 팀"
          value={data.total_teams}
          icon={Globe}
          color="default"
        />
        <OverviewCard
          label="등록 완료"
          value={data.assigned_count}
          icon={CheckCircle}
          color="ok"
        />
        <OverviewCard
          label="미등록"
          value={data.unassigned_count}
          icon={AlertTriangle}
          color="warning"
        />
        <OverviewCard
          label="VPN 발급"
          value={data.vpn_issued_count}
          icon={Shield}
          color="teal"
        />
      </div>

      {/* ── 2. 액션 버튼 영역 ─────────────────────── */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setAutoAssignOpen(true)}
          disabled={data.unassigned_count === 0}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors",
            data.unassigned_count === 0
              ? "bg-accent/30 text-white cursor-not-allowed"
              : "bg-accent hover:bg-accent/80 text-white",
          )}
        >
          <Wand2 className="w-4 h-4" />
          자동 할당 (10.10.X.0/24)
        </button>

        <button
          type="button"
          onClick={() => {
            setLoading(true);
            fetchSubnets();
          }}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          새로고침
        </button>
      </div>

      {/* ── 3. 안내 배너 ──────────────────────────── */}
      <div className="bg-bg-secondary border-l-4 border-accent rounded-lg p-3">
        <p className="text-sm text-text-secondary">
          네트워크 팀이 OpenVPN에서 생성한 VPN 대역을 여기에 등록하세요.
          등록된 VPN 대역으로 취약점팩이 배포됩니다.
        </p>
      </div>

      {/* ── 4. 팀-서브넷 테이블 ──────────────────── */}
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
                  팀 서버 IP
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-center">
                  VPN 프로필
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-center">
                  상태
                </th>
                <th className="px-4 py-3 font-medium text-text-muted text-right">
                  작업
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.teams.map((team) => (
                <tr
                  key={team.team_id}
                  className="hover:bg-bg-tertiary/30 transition-colors"
                >
                  {/* 팀 이름 */}
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-text-primary">
                        {team.team_name}
                      </p>
                      <p className="text-xs text-text-muted font-mono">
                        {team.team_code}
                      </p>
                    </div>
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

                  {/* 게이트웨이 */}
                  <td className="px-4 py-3">
                    {team.gateway_ip ? (
                      <span className="font-mono text-text-primary">
                        {team.gateway_ip}
                      </span>
                    ) : (
                      <span className="italic text-text-muted">-</span>
                    )}
                  </td>

                  {/* VPN 프로필 */}
                  <td className="px-4 py-3 text-center">
                    {team.vpn_profile_issued ? (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-status-ok/15 text-status-ok">
                        발급됨
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-400/15 text-amber-400">
                        미발급
                      </span>
                    )}
                  </td>

                  {/* 상태 */}
                  <td className="px-4 py-3 text-center">
                    {team.registration_status === "registered" ? (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-status-info/15 text-status-info">
                        등록완료
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-400/15 text-amber-400">
                        대기중
                      </span>
                    )}
                  </td>

                  {/* 작업 */}
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => openEditModal(team)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                    >
                      {team.subnet ? (
                        <>
                          <Pencil className="w-3.5 h-3.5" />
                          수정
                        </>
                      ) : (
                        <>
                          <Plus className="w-3.5 h-3.5" />
                          등록
                        </>
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 5. SubnetEditModal ───────────────────── */}
      {editTarget && (
        <SubnetEditModal
          open={editModalOpen}
          onOpenChange={(open) => {
            setEditModalOpen(open);
            if (!open) setEditTarget(null);
          }}
          competitionId={competitionId}
          team={editTarget}
          onSuccess={fetchSubnets}
        />
      )}

      {/* ── 6. 자동 할당 확인 모달 ──────────────── */}
      <ConfirmModal
        open={autoAssignOpen}
        onOpenChange={setAutoAssignOpen}
        title="VPN 대역 자동 할당"
        description="미등록 팀에 10.10.X.0/24를 순차 할당합니다."
        confirmLabel="자동 할당"
        variant="default"
        onConfirm={handleAutoAssign}
        isLoading={autoAssignLoading}
      />
    </div>
  );
}
