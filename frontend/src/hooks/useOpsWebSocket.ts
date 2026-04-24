"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
type EventHandler = (data: unknown) => void;

interface WsEvent {
  type: string;
  timestamp: string;
  data: unknown;
}

const MAX_RETRY_DELAY = 30000;

export function useOpsWebSocket() {
  const [connectionStatus, setStatus] =
    useState<ConnectionStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<EventHandler>>>(new Map());
  const retryCountRef = useRef(0);

  const connect = useCallback(async () => {
    const protocol =
      window.location.protocol === "https:" ? "wss:" : "ws:";
    // httpOnly 쿠키에서 직접 토큰을 읽을 수 없으므로,
    // 전용 엔드포인트에서 토큰을 받아 WebSocket에 전달한다.
    const tokenRes = await fetch("/api/auth/ws-token", {
      credentials: "include",
    });
    if (!tokenRes.ok) {
      setStatus("disconnected");
      return;
    }
    const { token } = await tokenRes.json();

    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/ws/events?token=${token}`,
    );

    ws.onopen = () => {
      setStatus("connected");
      retryCountRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsEvent = JSON.parse(event.data);
        if (msg.type === "ping") return;
        const handlers = listenersRef.current.get(msg.type);
        handlers?.forEach((h) => h(msg.data));
      } catch {
        /* 파싱 실패 무시 */
      }
    };

    ws.onclose = () => {
      setStatus("reconnecting");
      const delay = Math.min(
        1000 * Math.pow(2, retryCountRef.current),
        MAX_RETRY_DELAY,
      );
      retryCountRef.current++;
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const on = useCallback((eventType: string, handler: EventHandler) => {
    if (!listenersRef.current.has(eventType)) {
      listenersRef.current.set(eventType, new Set());
    }
    listenersRef.current.get(eventType)!.add(handler);
  }, []);

  const off = useCallback((eventType: string, handler: EventHandler) => {
    listenersRef.current.get(eventType)?.delete(handler);
  }, []);

  return { connectionStatus, on, off };
}
