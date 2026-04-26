"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { TeamServiceHealthcheckStepResult } from "@/types/ops";
import {
  countScenarioMethods,
  extractHealthcheckScenarioDocument,
  formatScenarioRequestLabel,
  summarizeScenarioExpectations,
} from "./healthcheckScenarioUtils";

type PanelTabKey = "overview" | "steps" | "json";

const PANEL_TABS: Array<{ key: PanelTabKey; label: string }> = [
  { key: "overview", label: "개요" },
  { key: "steps", label: "단계" },
  { key: "json", label: "JSON" },
];

function MetricCard({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-bg-secondary px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className={cn("mt-1 text-sm font-medium text-text-primary", muted && "text-text-secondary")}>
        {value}
      </p>
    </div>
  );
}

export default function HealthCheckScenarioPanel({
  endpoint,
  scenarios,
  stepResults = null,
  loading = false,
  errorMessage = null,
}: {
  endpoint: string | null;
  scenarios: Record<string, unknown> | null;
  stepResults?: TeamServiceHealthcheckStepResult[] | null;
  loading?: boolean;
  errorMessage?: string | null;
}) {
  const [activeTab, setActiveTab] = useState<PanelTabKey>("overview");
  const document = useMemo(
    () => extractHealthcheckScenarioDocument(scenarios),
    [scenarios],
  );
  const prettyJson = useMemo(
    () => (scenarios ? JSON.stringify(scenarios, null, 2) : ""),
    [scenarios],
  );
  const stepResultByIndex = useMemo(
    () => new Map((stepResults ?? []).map((step) => [step.step_index, step])),
    [stepResults],
  );
  const stepCount = document?.steps.length ?? 0;
  const modeLabel = stepCount > 0 ? "시나리오 기반 검증" : endpoint ? "엔드포인트 기반 검증" : "TCP 연결 체크";

  function renderStepStatus(stepResult: TeamServiceHealthcheckStepResult | undefined) {
    if (loading) {
      return (
        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary">
          검사 중
        </span>
      );
    }
    if (!stepResult) {
      return (
        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-muted">
          미확인
        </span>
      );
    }
    if (stepResult.status === "passed") {
      return (
        <span className="rounded-full bg-status-success/10 px-2.5 py-1 text-[11px] font-medium text-status-success">
          정상
        </span>
      );
    }
    if (stepResult.status === "failed") {
      return (
        <span className="rounded-full bg-status-danger/10 px-2.5 py-1 text-[11px] font-medium text-status-danger">
          실패
        </span>
      );
    }
    return (
      <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-muted">
        미실행
      </span>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 bg-bg-tertiary/30 p-4 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">헬스체크</h3>
          <p className="text-xs text-text-muted">
            엔드포인트, 시나리오 step, 원본 JSON을 분리해서 확인합니다.
          </p>
        </div>
        <nav className="grid w-full max-w-[18rem] shrink-0 grid-cols-3 gap-1 rounded-lg border border-border bg-bg-secondary p-1">
          {PANEL_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "min-w-0 whitespace-nowrap rounded-md px-3 py-2 text-center text-xs font-medium transition-colors",
                activeTab === tab.key
                  ? "bg-bg-tertiary text-text-primary"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <MetricCard label="검증 방식" value={modeLabel} />
            <MetricCard label="헬스체크 경로" value={endpoint ?? "미설정"} muted={!endpoint} />
            <MetricCard label="시나리오 step" value={stepCount > 0 ? `${stepCount}개` : "미설정"} muted={stepCount === 0} />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <MetricCard
              label="요청 메서드 수"
              value={stepCount > 0 ? `${countScenarioMethods(document)}종류` : "-"}
              muted={stepCount === 0}
            />
            <MetricCard
              label="추가 설명"
              value={
                stepCount > 0
                  ? "배포 검증과 SLA 체크가 같은 시나리오를 사용합니다."
                  : "시나리오가 비어 있으면 엔드포인트 또는 TCP 체크로 동작합니다."
              }
            />
            <MetricCard
              label="원본 JSON"
              value={scenarios ? "저장됨" : "없음"}
              muted={!scenarios}
            />
          </div>
        </div>
      )}

      {activeTab === "steps" && (
        <div className="space-y-3">
          {errorMessage && (
            <div className="rounded-lg border border-status-danger/30 bg-status-danger/5 px-4 py-3">
              <p className="text-xs font-semibold text-status-danger">실시간 헬스체크 오류</p>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-status-danger/90">
                {errorMessage}
              </pre>
            </div>
          )}

          {document?.steps.length ? (
            document.steps.map((step, index) => {
              const expectationSummary = summarizeScenarioExpectations(step);
              const stepResult = stepResultByIndex.get(index);
              return (
                <div
                  key={`${step.name ?? "step"}-${index}`}
                  className="rounded-lg border border-border/60 bg-bg-secondary px-4 py-3"
                >
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {step.name?.trim() || `Step ${index + 1}`}
                      </p>
                      <p className="font-mono text-xs text-text-secondary">
                        {formatScenarioRequestLabel(step)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {typeof step.request?.timeout_seconds === "number" && (
                        <span className="text-xs text-text-muted">
                          timeout {step.request.timeout_seconds}s
                        </span>
                      )}
                      {renderStepStatus(stepResult)}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {expectationSummary.length ? (
                      expectationSummary.map((item) => (
                        <span
                          key={item}
                          className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-secondary"
                        >
                          {item}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-text-muted">기대한 응답 조건이 비어 있습니다.</span>
                    )}
                  </div>
                  {stepResult && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                      {typeof stepResult.response_time_ms === "number" && (
                        <span className="rounded-full bg-bg-tertiary px-2.5 py-1 font-medium text-text-secondary">
                          {stepResult.response_time_ms} ms
                        </span>
                      )}
                      {stepResult.error_message && (
                        <span className="text-status-danger">{stepResult.error_message}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : stepResults?.length ? (
            stepResults.map((stepResult) => (
              <div
                key={`live-step-${stepResult.step_index}`}
                className="rounded-lg border border-border/60 bg-bg-secondary px-4 py-3"
              >
                <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-medium text-text-primary">
                      {stepResult.name?.trim() || `Step ${stepResult.step_index + 1}`}
                    </p>
                    <p className="font-mono text-xs text-text-secondary">{stepResult.request_label}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {typeof stepResult.response_time_ms === "number" && (
                      <span className="text-xs text-text-muted">{stepResult.response_time_ms} ms</span>
                    )}
                    {renderStepStatus(stepResult)}
                  </div>
                </div>
                {stepResult.error_message && (
                  <p className="mt-3 text-xs text-status-danger">{stepResult.error_message}</p>
                )}
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-bg-secondary px-4 py-8 text-center text-sm text-text-muted">
              저장된 헬스체크 시나리오가 없습니다.
            </div>
          )}
        </div>
      )}

      {activeTab === "json" && (
        <div className="rounded-lg border border-border/60 bg-bg-secondary overflow-hidden">
          {prettyJson ? (
            <pre className="overflow-x-auto px-4 py-3 text-xs text-text-secondary">
              <code>{prettyJson}</code>
            </pre>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              저장된 JSON이 없습니다.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
