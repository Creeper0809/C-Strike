"use client";

import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  HealthcheckScenarioDocument,
  HealthcheckScenarioExpect,
  HealthcheckScenarioRequest,
  HealthcheckScenarioStep,
} from "./healthcheckScenarioUtils";
import {
  countScenarioMethods,
  formatScenarioRequestLabel,
  parseHealthcheckScenarioText,
  summarizeScenarioExpectations,
} from "./healthcheckScenarioUtils";

const HTTP_METHOD_OPTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

function createDefaultScenarioStep(index = 1): HealthcheckScenarioStep {
  return {
    name: `Step ${index}`,
    request: {
      method: "GET",
      path: "/",
      timeout_seconds: 10,
    },
    expect: {
      status: 200,
      body_contains: [],
      body_not_contains: [],
      status_in: [],
      json_paths_present: [],
      json_path_equals: {},
      header_contains: {},
    },
  };
}

function createDefaultScenarioDocument(): HealthcheckScenarioDocument {
  return {
    version: 1,
    steps: [createDefaultScenarioStep(1)],
  };
}

const DEFAULT_SCENARIO_TEMPLATE: HealthcheckScenarioDocument = {
  version: 1,
  steps: [
    {
      name: "루트 페이지 확인",
      request: {
        method: "GET",
        path: "/",
        timeout_seconds: 10,
      },
      expect: {
        status: 200,
        body_contains: ["Index of /", "team-info.txt", "flag.txt"],
      },
    },
    {
      name: "팀 정보 파일 확인",
      request: {
        method: "GET",
        path: "/team-info.txt",
        timeout_seconds: 10,
      },
      expect: {
        status: 200,
        body_contains: ["team_name=", "team_code="],
      },
    },
  ],
};

interface HealthCheckScenarioEditorProps {
  value: HealthcheckScenarioDocument | null;
  onChange: (value: HealthcheckScenarioDocument | null) => void;
  disabled?: boolean;
}

function cloneDocument(document: HealthcheckScenarioDocument): HealthcheckScenarioDocument {
  return {
    version: document.version ?? 1,
    steps: document.steps.map((step) => ({
      name: step.name ?? "",
      request: step.request ? { ...step.request } : {},
      expect: step.expect
        ? {
            ...step.expect,
            body_contains: [...(step.expect.body_contains ?? [])],
            body_not_contains: [...(step.expect.body_not_contains ?? [])],
            status_in: [...(step.expect.status_in ?? [])],
            json_paths_present: [...(step.expect.json_paths_present ?? [])],
            json_path_equals: { ...(step.expect.json_path_equals ?? {}) },
            header_contains: { ...(step.expect.header_contains ?? {}) },
          }
        : {},
    })),
  };
}

function parseLineList(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatLineList(values?: string[] | null): string {
  return (values ?? []).join("\n");
}

function parseNumberList(value: string): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function formatNumberList(values?: number[] | null): string {
  return (values ?? []).join(", ");
}

function parseKeyValueLines(value: string): Record<string, string> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, line) => {
      const separatorIndex = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
      if (separatorIndex < 0) return acc;
      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      if (!key) return acc;
      acc[key] = rawValue;
      return acc;
    }, {});
}

function formatKeyValueLines(values?: Record<string, string> | null): string {
  return Object.entries(values ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function parseJsonPathEqualsLines(value: string): Record<string, unknown> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, unknown>>((acc, line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex < 0) return acc;
      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      if (!key) return acc;
      try {
        acc[key] = JSON.parse(rawValue);
      } catch {
        acc[key] = rawValue;
      }
      return acc;
    }, {});
}

function formatJsonPathEqualsLines(values?: Record<string, unknown> | null): string {
  return Object.entries(values ?? {})
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function normalizeStep(step: HealthcheckScenarioStep, index: number): HealthcheckScenarioStep {
  const request: HealthcheckScenarioRequest = {
    method: step.request?.method?.toUpperCase() || "GET",
    path: step.request?.path || "/",
    timeout_seconds:
      typeof step.request?.timeout_seconds === "number" && step.request.timeout_seconds > 0
        ? step.request.timeout_seconds
        : 10,
    headers: { ...(step.request?.headers ?? {}) },
    query: { ...(step.request?.query ?? {}) },
    body: step.request?.body ?? "",
    json_body: step.request?.json_body,
  };

  const expect: HealthcheckScenarioExpect = {
    status: typeof step.expect?.status === "number" ? step.expect.status : 200,
    status_in: [...(step.expect?.status_in ?? [])],
    body_contains: [...(step.expect?.body_contains ?? [])],
    body_not_contains: [...(step.expect?.body_not_contains ?? [])],
    header_contains: { ...(step.expect?.header_contains ?? {}) },
    json_paths_present: [...(step.expect?.json_paths_present ?? [])],
    json_path_equals: { ...(step.expect?.json_path_equals ?? {}) },
  };

  return {
    name: step.name?.trim() || `Step ${index + 1}`,
    request,
    expect,
  };
}

export default function HealthCheckScenarioEditor({
  value,
  onChange,
  disabled = false,
}: HealthCheckScenarioEditorProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "steps" | "template">("overview");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const document = useMemo(() => {
    if (!value) return null;
    return cloneDocument(value);
  }, [value]);
  const stepCount = document?.steps.length ?? 0;
  const methodCount = countScenarioMethods(document);

  function ensureDocument(): HealthcheckScenarioDocument {
    return cloneDocument(document ?? createDefaultScenarioDocument());
  }

  function updateDocument(next: HealthcheckScenarioDocument | null) {
    onChange(next);
  }

  async function handleJsonUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const { document: parsedDocument, error } = parseHealthcheckScenarioText(text);
      if (error) {
        setUploadError(error);
        setUploadedFileName(null);
        return;
      }

      updateDocument(parsedDocument ? cloneDocument(parsedDocument) : null);
      setUploadError(null);
      setUploadedFileName(file.name);
      setActiveTab(parsedDocument ? "steps" : "overview");
    } catch {
      setUploadError("JSON 파일을 읽는 중 문제가 발생했습니다.");
      setUploadedFileName(null);
    }
  }

  function updateStep(index: number, updater: (step: HealthcheckScenarioStep) => HealthcheckScenarioStep) {
    const next = ensureDocument();
    next.steps = next.steps.map((step, stepIndex) =>
      stepIndex === index ? normalizeStep(updater(normalizeStep(step, stepIndex)), stepIndex) : normalizeStep(step, stepIndex),
    );
    updateDocument(next);
  }

  function addStep() {
    const next = ensureDocument();
    next.steps = [...next.steps.map(normalizeStep), createDefaultScenarioStep(next.steps.length + 1)];
    updateDocument(next);
  }

  function removeStep(index: number) {
    const next = ensureDocument();
    if (next.steps.length <= 1) {
      updateDocument(createDefaultScenarioDocument());
      return;
    }
    next.steps = next.steps.filter((_, stepIndex) => stepIndex !== index).map(normalizeStep);
    updateDocument(next);
  }

  const normalizedSteps = document?.steps.map(normalizeStep) ?? [];

  return (
    <div className="space-y-4 rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">헬스체크 시나리오</p>
          <p className="text-xs text-text-muted">
            문제 제작자가 정의한 요청-응답 흐름을 입력칸으로 설정합니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleJsonUpload}
            disabled={disabled}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            JSON 업로드
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setUploadError(null);
              setUploadedFileName(null);
              onChange(cloneDocument(DEFAULT_SCENARIO_TEMPLATE));
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            예시 넣기
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setUploadError(null);
              setUploadedFileName(null);
              onChange(null);
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            시나리오 비우기
          </button>
        </div>
      </div>

      {(uploadError || uploadedFileName) && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            uploadError
              ? "border-status-danger/30 bg-status-danger/5 text-status-danger"
              : "border-border bg-bg-tertiary/50 text-text-secondary",
          )}
        >
          {uploadError ? (
            <span>JSON 업로드 실패: {uploadError}</span>
          ) : (
            <span>
              JSON 파일을 불러왔습니다: <span className="font-medium text-text-primary">{uploadedFileName}</span>
            </span>
          )}
        </div>
      )}

      <nav className="flex gap-1 rounded-lg border border-border bg-bg-tertiary/70 p-1 w-fit">
        {[
          { key: "overview", label: "개요" },
          { key: "steps", label: "step 편집" },
          { key: "template", label: "예시 템플릿" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key as "overview" | "steps" | "template")}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === tab.key
                ? "bg-bg-secondary text-text-primary"
                : "text-text-muted hover:text-text-secondary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" && (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <SummaryTile label="시나리오 step" value={stepCount > 0 ? `${stepCount}개` : "미설정"} />
            <SummaryTile label="요청 메서드" value={stepCount > 0 ? `${methodCount}종류` : "-"} />
            <SummaryTile
              label="Fallback"
              value={stepCount > 0 ? "시나리오 우선 사용" : "엔드포인트/TCP 체크"}
            />
          </div>

          {normalizedSteps.length ? (
            <div className="space-y-3">
              {normalizedSteps.map((step, index) => {
                const expectationSummary = summarizeScenarioExpectations(step);
                return (
                  <div
                    key={`${step.name ?? "step"}-${index}`}
                    className="rounded-lg border border-border/60 bg-bg-tertiary/50 px-4 py-3"
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
                      {typeof step.request?.timeout_seconds === "number" && (
                        <span className="text-xs text-text-muted">
                          timeout {step.request.timeout_seconds}s
                        </span>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {expectationSummary.length ? (
                        expectationSummary.map((item) => (
                          <span
                            key={item}
                            className="rounded-full bg-bg-secondary px-2.5 py-1 text-[11px] font-medium text-text-secondary"
                          >
                            {item}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-text-muted">
                          기대 응답 조건이 비어 있습니다.
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-bg-tertiary/40 px-4 py-8 text-center text-sm text-text-muted">
              시나리오가 비어 있으면 기존 엔드포인트/TCP 체크를 사용합니다.
            </div>
          )}
        </div>
      )}

      {activeTab === "steps" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={addStep}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              step 추가
            </button>
          </div>

          {normalizedSteps.map((step, index) => (
            <div
              key={`${step.name ?? "step"}-${index}`}
              className="space-y-4 rounded-lg border border-border bg-bg-secondary p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Step {index + 1}</p>
                  <p className="text-xs text-text-muted">요청과 기대 응답을 각각 입력합니다.</p>
                </div>
                <button
                  type="button"
                  onClick={() => removeStep(index)}
                  disabled={disabled}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-status-danger hover:bg-status-danger/10 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  삭제
                </button>
              </div>

              <label className="space-y-1.5 block">
                <span className="text-xs font-medium text-text-secondary">step 이름</span>
                <input
                  type="text"
                  value={step.name ?? ""}
                  onChange={(e) => updateStep(index, (current) => ({ ...current, name: e.target.value }))}
                  disabled={disabled}
                  className="form-input"
                  placeholder="예: 루트 페이지 확인"
                />
              </label>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="space-y-3 rounded-lg border border-border/60 bg-bg-tertiary/30 p-4">
                  <p className="text-sm font-semibold text-text-primary">요청</p>
                  <div className="grid gap-3 md:grid-cols-[140px_minmax(0,1fr)_120px]">
                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">메서드</span>
                      <select
                        value={step.request?.method ?? "GET"}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            request: { ...(current.request ?? {}), method: e.target.value },
                          }))
                        }
                        disabled={disabled}
                        className="form-input"
                      >
                        {HTTP_METHOD_OPTIONS.map((method) => (
                          <option key={method} value={method}>
                            {method}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">경로</span>
                      <input
                        type="text"
                        value={step.request?.path ?? "/"}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            request: { ...(current.request ?? {}), path: e.target.value },
                          }))
                        }
                        disabled={disabled}
                        className="form-input font-mono text-xs"
                        placeholder="/api/health"
                      />
                    </label>

                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">timeout(s)</span>
                      <input
                        type="number"
                        min={1}
                        value={step.request?.timeout_seconds ?? 10}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            request: {
                              ...(current.request ?? {}),
                              timeout_seconds: Math.max(1, Number(e.target.value) || 1),
                            },
                          }))
                        }
                        disabled={disabled}
                        className="form-input"
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 xl:grid-cols-2">
                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">query</span>
                      <textarea
                        rows={4}
                        value={formatKeyValueLines(step.request?.query)}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            request: { ...(current.request ?? {}), query: parseKeyValueLines(e.target.value) },
                          }))
                        }
                        disabled={disabled}
                        className="form-input resize-none font-mono text-xs"
                        placeholder={"page=1\nsize=10"}
                      />
                    </label>

                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">headers</span>
                      <textarea
                        rows={4}
                        value={formatKeyValueLines(step.request?.headers)}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            request: { ...(current.request ?? {}), headers: parseKeyValueLines(e.target.value) },
                          }))
                        }
                        disabled={disabled}
                        className="form-input resize-none font-mono text-xs"
                        placeholder={"Authorization: Bearer ...\nX-Test: 1"}
                      />
                    </label>
                  </div>

                  <label className="space-y-1.5 block">
                    <span className="text-xs font-medium text-text-secondary">본문(body)</span>
                    <textarea
                      rows={4}
                      value={typeof step.request?.body === "string" ? step.request.body : ""}
                      onChange={(e) =>
                        updateStep(index, (current) => ({
                          ...current,
                          request: { ...(current.request ?? {}), body: e.target.value },
                        }))
                      }
                      disabled={disabled}
                      className="form-input resize-none font-mono text-xs"
                      placeholder='{"username":"demo"} 또는 폼 데이터'
                    />
                  </label>
                </div>

                <div className="space-y-3 rounded-lg border border-border/60 bg-bg-tertiary/30 p-4">
                  <p className="text-sm font-semibold text-text-primary">기대 응답</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">대표 상태코드</span>
                      <input
                        type="number"
                        min={100}
                        max={599}
                        value={step.expect?.status ?? 200}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            expect: {
                              ...(current.expect ?? {}),
                              status: Math.max(100, Math.min(599, Number(e.target.value) || 200)),
                            },
                          }))
                        }
                        disabled={disabled}
                        className="form-input"
                      />
                    </label>

                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">허용 상태코드 목록</span>
                      <input
                        type="text"
                        value={formatNumberList(step.expect?.status_in)}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            expect: { ...(current.expect ?? {}), status_in: parseNumberList(e.target.value) },
                          }))
                        }
                        disabled={disabled}
                        className="form-input"
                        placeholder="200, 201"
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 xl:grid-cols-2">
                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">본문 포함 문자열</span>
                      <textarea
                        rows={5}
                        value={formatLineList(step.expect?.body_contains)}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            expect: { ...(current.expect ?? {}), body_contains: parseLineList(e.target.value) },
                          }))
                        }
                        disabled={disabled}
                        className="form-input resize-none"
                        placeholder={"OK\nteam-info.txt"}
                      />
                    </label>

                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">본문 제외 문자열</span>
                      <textarea
                        rows={5}
                        value={formatLineList(step.expect?.body_not_contains)}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            expect: { ...(current.expect ?? {}), body_not_contains: parseLineList(e.target.value) },
                          }))
                        }
                        disabled={disabled}
                        className="form-input resize-none"
                        placeholder={"Error\nTraceback"}
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 xl:grid-cols-2">
                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">헤더 포함 검사</span>
                      <textarea
                        rows={4}
                        value={formatKeyValueLines(step.expect?.header_contains)}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            expect: {
                              ...(current.expect ?? {}),
                              header_contains: parseKeyValueLines(e.target.value),
                            },
                          }))
                        }
                        disabled={disabled}
                        className="form-input resize-none font-mono text-xs"
                        placeholder={"content-type: text/html\nset-cookie: session="}
                      />
                    </label>

                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-text-secondary">JSON 경로 존재 검사</span>
                      <textarea
                        rows={4}
                        value={formatLineList(step.expect?.json_paths_present)}
                        onChange={(e) =>
                          updateStep(index, (current) => ({
                            ...current,
                            expect: {
                              ...(current.expect ?? {}),
                              json_paths_present: parseLineList(e.target.value),
                            },
                          }))
                        }
                        disabled={disabled}
                        className="form-input resize-none font-mono text-xs"
                        placeholder={"data.items\nmeta.total"}
                      />
                    </label>
                  </div>

                  <label className="space-y-1.5 block">
                    <span className="text-xs font-medium text-text-secondary">JSON 경로 값 비교</span>
                    <textarea
                      rows={4}
                      value={formatJsonPathEqualsLines(step.expect?.json_path_equals)}
                      onChange={(e) =>
                        updateStep(index, (current) => ({
                          ...current,
                          expect: {
                            ...(current.expect ?? {}),
                            json_path_equals: parseJsonPathEqualsLines(e.target.value),
                          },
                        }))
                      }
                      disabled={disabled}
                      className="form-input resize-none font-mono text-xs"
                      placeholder={'meta.status="ok"\ndata.count=3'}
                    />
                  </label>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === "template" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border/60 bg-bg-tertiary/50 px-4 py-3 text-sm text-text-secondary">
            자주 쓰는 기본 예시입니다. 이 템플릿으로 교체한 뒤 경로와 기대 응답만 다듬으면 됩니다.
          </div>
          <div className="space-y-3">
            {DEFAULT_SCENARIO_TEMPLATE.steps.map((step, index) => (
              <div
                key={`${step.name ?? "template"}-${index}`}
                className="rounded-lg border border-border/60 bg-bg-tertiary/40 px-4 py-3"
              >
                <p className="text-sm font-medium text-text-primary">{step.name}</p>
                <p className="mt-1 font-mono text-xs text-text-secondary">
                  {formatScenarioRequestLabel(step)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {summarizeScenarioExpectations(step).map((item) => (
                    <span
                      key={item}
                      className="rounded-full bg-bg-secondary px-2.5 py-1 text-[11px] font-medium text-text-secondary"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(cloneDocument(DEFAULT_SCENARIO_TEMPLATE))}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              이 예시로 교체
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-bg-tertiary/50 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-1 text-sm font-medium text-text-primary">{value}</p>
    </div>
  );
}
