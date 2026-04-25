export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function normalizeErrorDetail(detail: unknown): string | null {
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const message = record.msg;
          if (typeof message === "string" && message.trim()) {
            return message.trim();
          }
        }
        return "";
      })
      .filter(Boolean);

    if (messages.length > 0) {
      return messages.join(", ");
    }
  }

  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
  }

  return null;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const headers: HeadersInit = isFormData
    ? { ...(options.headers as Record<string, string>) }
    : { "Content-Type": "application/json", ...(options.headers as Record<string, string>) };

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const fallback: Record<number, string> = {
      502: "백엔드 서비스에 연결할 수 없습니다.",
      503: "서비스가 일시적으로 사용 불가합니다.",
      504: "서버 응답 시간이 초과되었습니다.",
    };
    const message =
      normalizeErrorDetail(body.detail) ||
      fallback[res.status] ||
      res.statusText;
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}
