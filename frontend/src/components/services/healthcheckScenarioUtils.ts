"use client";

export interface HealthcheckScenarioRequest {
  method?: string;
  path?: string;
  timeout_seconds?: number;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string | null;
  json_body?: unknown;
}

export interface HealthcheckScenarioExpect {
  status?: number | null;
  status_in?: number[] | null;
  body_contains?: string[];
  body_not_contains?: string[];
  header_contains?: Record<string, string>;
  json_paths_present?: string[];
  json_path_equals?: Record<string, unknown>;
}

export interface HealthcheckScenarioStep {
  name?: string;
  request?: HealthcheckScenarioRequest;
  expect?: HealthcheckScenarioExpect;
}

export interface HealthcheckScenarioDocument {
  version?: number;
  steps: HealthcheckScenarioStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractHealthcheckScenarioDocument(
  value: unknown,
): HealthcheckScenarioDocument | null {
  if (!isRecord(value)) return null;
  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps)) return null;

  const steps = rawSteps.map((step) => {
    if (!isRecord(step)) return {};
    return {
      name: typeof step.name === "string" ? step.name : undefined,
      request: isRecord(step.request) ? (step.request as HealthcheckScenarioRequest) : undefined,
      expect: isRecord(step.expect) ? (step.expect as HealthcheckScenarioExpect) : undefined,
    };
  });

  return {
    version: typeof value.version === "number" ? value.version : undefined,
    steps,
  };
}

export function parseHealthcheckScenarioText(value: string): {
  document: HealthcheckScenarioDocument | null;
  error: string | null;
} {
  const trimmed = value.trim();
  if (!trimmed) {
    return { document: null, error: null };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const document = extractHealthcheckScenarioDocument(parsed);
    if (!document) {
      return { document: null, error: "steps 배열을 가진 JSON 객체 형식이어야 합니다." };
    }
    return { document, error: null };
  } catch {
    return { document: null, error: "JSON 문법을 확인해 주세요." };
  }
}

export function formatScenarioRequestLabel(step: HealthcheckScenarioStep): string {
  const method = step.request?.method ?? "GET";
  const path = step.request?.path ?? "/";
  return `${method.toUpperCase()} ${path}`;
}

export function summarizeScenarioExpectations(
  step: HealthcheckScenarioStep,
): string[] {
  const expect = step.expect;
  if (!expect) return [];

  const parts: string[] = [];

  if (typeof expect.status === "number") {
    parts.push(`status ${expect.status}`);
  } else if (Array.isArray(expect.status_in) && expect.status_in.length > 0) {
    parts.push(`status ${expect.status_in.join(", ")}`);
  }

  if (Array.isArray(expect.body_contains) && expect.body_contains.length > 0) {
    parts.push(`본문 포함 ${expect.body_contains.length}개`);
  }

  if (Array.isArray(expect.body_not_contains) && expect.body_not_contains.length > 0) {
    parts.push(`본문 제외 ${expect.body_not_contains.length}개`);
  }

  if (expect.header_contains && Object.keys(expect.header_contains).length > 0) {
    parts.push(`헤더 검사 ${Object.keys(expect.header_contains).length}개`);
  }

  if (Array.isArray(expect.json_paths_present) && expect.json_paths_present.length > 0) {
    parts.push(`JSON 존재 검사 ${expect.json_paths_present.length}개`);
  }

  if (expect.json_path_equals && Object.keys(expect.json_path_equals).length > 0) {
    parts.push(`JSON 값 비교 ${Object.keys(expect.json_path_equals).length}개`);
  }

  return parts;
}

export function countScenarioMethods(
  document: HealthcheckScenarioDocument | null,
): number {
  if (!document) return 0;
  return new Set(
    document.steps
      .map((step) => step.request?.method?.toUpperCase())
      .filter((value): value is string => Boolean(value)),
  ).size;
}

