"use client";

import { useEffect } from "react";

/**
 * WebSocket 연결이 끊어졌을 때 폴링으로 데이터를 갱신하는 폴백 훅.
 * wsStatus가 "connected"가 아닐 때만 활성화된다.
 */
export function usePollingFallback(
  wsStatus: string,
  fetchFn: () => Promise<void>,
  intervalMs: number = 15000,
) {
  useEffect(() => {
    if (wsStatus === "connected") return;

    fetchFn();
    const id = setInterval(fetchFn, intervalMs);
    return () => clearInterval(id);
  }, [wsStatus, intervalMs]); // fetchFn은 의도적으로 제외 (호출자가 useCallback으로 안정화)
}
