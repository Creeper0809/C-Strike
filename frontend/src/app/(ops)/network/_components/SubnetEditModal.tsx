"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { TeamSubnetInfo, SubnetAssignResponse } from "@/types/ops";

/* ─── Props ──────────────────────────────────────────── */

interface SubnetEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  competitionId: string;
  team: TeamSubnetInfo;
  onSuccess: () => void;
}

/* ─── 검증 정규식 ────────────────────────────────────── */

const CIDR_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
const IP_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/* ─── 컴포넌트 ───────────────────────────────────────── */

export default function SubnetEditModal({
  open,
  onOpenChange,
  competitionId,
  team,
  onSuccess,
}: SubnetEditModalProps) {
  const [subnet, setSubnet] = useState("");
  const [gatewayIp, setGatewayIp] = useState("");
  const [subnetError, setSubnetError] = useState<string | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isEditMode = team.subnet !== null;

  /* 모달 열릴 때 초기값 세팅 */
  useEffect(() => {
    if (open) {
      setSubnet(team.subnet ?? "");
      setGatewayIp(team.gateway_ip ?? "");
      setSubnetError(null);
      setGatewayError(null);
      setApiError(null);
      setSaving(false);
    }
  }, [open, team.subnet, team.gateway_ip]);

  /* ── 인라인 검증 ─────────────────────────────────── */

  function validateSubnet(value: string): string | null {
    if (!value.trim()) return "VPN 대역을 입력하세요.";
    if (!CIDR_REGEX.test(value.trim())) return "올바른 CIDR 형식이 아닙니다. (예: 10.10.1.0/24)";
    return null;
  }

  function validateGateway(value: string): string | null {
    if (!value.trim()) return "팀 서버 IP를 입력하세요.";
    if (!IP_REGEX.test(value.trim())) return "올바른 IP 형식이 아닙니다. (예: 10.10.1.1)";
    return null;
  }

  function handleSubnetChange(value: string) {
    setSubnet(value);
    if (subnetError) setSubnetError(validateSubnet(value));
  }

  function handleGatewayChange(value: string) {
    setGatewayIp(value);
    if (gatewayError) setGatewayError(validateGateway(value));
  }

  /* ── 저장 ────────────────────────────────────────── */

  async function handleSave() {
    const sErr = validateSubnet(subnet);
    const gErr = validateGateway(gatewayIp);
    setSubnetError(sErr);
    setGatewayError(gErr);

    if (sErr || gErr) return;

    setSaving(true);
    setApiError(null);

    try {
      await apiFetch<SubnetAssignResponse>(
        `/v1/competitions/${competitionId}/network/subnets/${team.team_id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            subnet: subnet.trim(),
            gateway_ip: gatewayIp.trim(),
          }),
        },
      );
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setApiError(
        err instanceof Error ? err.message : "저장에 실패했습니다.",
      );
    } finally {
      setSaving(false);
    }
  }

  /* ── 저장 버튼 비활성 조건 ───────────────────────── */

  const isDisabled =
    saving ||
    !subnet.trim() ||
    !gatewayIp.trim() ||
    !!subnetError ||
    !!gatewayError;

  /* ── 렌더링 ──────────────────────────────────────── */

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* 오버레이 */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        {/* 콘텐츠 */}
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 bg-bg-secondary border border-border rounded-xl p-6 shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          {/* 닫기 버튼 */}
          <Dialog.Close asChild>
            <button
              type="button"
              className="absolute right-4 top-4 p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
              aria-label="닫기"
            >
              <X className="w-4 h-4" />
            </button>
          </Dialog.Close>

          {/* 헤더 */}
          <Dialog.Title className="text-lg font-semibold text-text-primary pr-8">
            {isEditMode ? "VPN 대역 수정" : "VPN 대역 등록"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            {team.team_name} 팀의 VPN 대역 정보를 {isEditMode ? "수정" : "등록"}합니다.
          </Dialog.Description>

          {/* 폼 */}
          <div className="mt-5 space-y-4">
            {/* 팀 이름 (읽기 전용) */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                팀 이름
              </label>
              <div className="px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-muted">
                {team.team_name}
              </div>
            </div>

            {/* 서브넷 입력 */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                VPN 대역 (CIDR)
              </label>
              <input
                type="text"
                value={subnet}
                onChange={(e) => handleSubnetChange(e.target.value)}
                onBlur={() => setSubnetError(validateSubnet(subnet))}
                placeholder="10.10.1.0/24"
                className={cn(
                  "w-full px-3 py-2 bg-bg-tertiary border rounded-lg text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 transition-colors",
                  subnetError
                    ? "border-status-danger focus:border-status-danger focus:ring-status-danger"
                    : "border-border focus:border-accent focus:ring-accent",
                )}
              />
              {subnetError && (
                <p className="mt-1 text-xs text-status-danger">{subnetError}</p>
              )}
            </div>

            {/* 게이트웨이 IP 입력 */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                팀 서버 IP
              </label>
              <input
                type="text"
                value={gatewayIp}
                onChange={(e) => handleGatewayChange(e.target.value)}
                onBlur={() => setGatewayError(validateGateway(gatewayIp))}
                placeholder="10.10.1.1"
                className={cn(
                  "w-full px-3 py-2 bg-bg-tertiary border rounded-lg text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 transition-colors",
                  gatewayError
                    ? "border-status-danger focus:border-status-danger focus:ring-status-danger"
                    : "border-border focus:border-accent focus:ring-accent",
                )}
              />
              {gatewayError && (
                <p className="mt-1 text-xs text-status-danger">{gatewayError}</p>
              )}
            </div>

            {/* API 에러 */}
            {apiError && (
              <div className="px-3 py-2 bg-status-danger/10 border border-status-danger/30 rounded-lg">
                <p className="text-xs text-status-danger">{apiError}</p>
              </div>
            )}
          </div>

          {/* 하단 버튼 */}
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
              onClick={handleSave}
              disabled={isDisabled}
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors",
                isDisabled
                  ? "bg-accent/30 text-white cursor-not-allowed"
                  : "bg-accent hover:bg-accent/80 text-white",
              )}
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? "저장 중..." : "저장"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
