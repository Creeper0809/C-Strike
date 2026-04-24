"use client";

import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Network, Settings, Rocket, Loader2, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/ui/PageHeader";
import NetworkMonitorTab from "./_components/NetworkMonitorTab";
import SubnetSetupTab from "./_components/SubnetSetupTab";
import DeployStatusTab from "./_components/DeployStatusTab";

const TABS = [
  { value: "subnet", label: "VPN 대역 설정", icon: Settings },
  { value: "monitor", label: "네트워크 모니터링", icon: Network },
  { value: "deploy", label: "배포 현황", icon: Rocket },
] as const;

export default function NetworkPage() {
  const [competitionId, setCompetitionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("subnet");

  useEffect(() => {
    async function fetchCompetitionId() {
      try {
        const data = await apiFetch<{ items: { id: string }[] }>(
          "/v1/competitions/?page=1&size=1",
        );
        if (data.items.length > 0) {
          setCompetitionId(data.items[0].id);
        } else {
          setError("등록된 대회가 없습니다.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "대회 정보를 불러올 수 없습니다.");
      } finally {
        setLoading(false);
      }
    }
    fetchCompetitionId();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="네트워크 관제" description="대회 정보를 불러오는 중..." />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      </div>
    );
  }

  if (error && !competitionId) {
    return (
      <div className="space-y-6">
        <PageHeader title="네트워크 관제" />
        <div className="bg-bg-secondary border border-border rounded-xl p-8 flex flex-col items-center gap-4">
          <AlertTriangle className="w-8 h-8 text-status-warning" />
          <p className="text-sm text-status-danger">{error}</p>
        </div>
      </div>
    );
  }

  if (!competitionId) return null;

  return (
    <div className="space-y-6">
      <PageHeader title="네트워크 관제" />

      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        <Tabs.List className="flex gap-1 border-b border-border mb-6">
          {TABS.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
                activeTab === tab.value
                  ? "border-accent text-accent"
                  : "border-transparent text-text-muted hover:text-text-secondary hover:border-border",
              )}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="subnet">
          <SubnetSetupTab competitionId={competitionId} />
        </Tabs.Content>
        <Tabs.Content value="monitor">
          <NetworkMonitorTab competitionId={competitionId} />
        </Tabs.Content>
        <Tabs.Content value="deploy">
          <DeployStatusTab competitionId={competitionId} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
