"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { apiFetch, ApiError } from "@/lib/api-client";
import type { Operator } from "@/types/ops";

/** 토큰 만료 30분 전에 자동 갱신 (ms) */
const REFRESH_INTERVAL = (480 - 30) * 60 * 1000;

interface AuthContextType {
  operator: Operator | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMe = useCallback(async () => {
    try {
      const data = await apiFetch<Operator>("/auth/me");
      setOperator(data);
    } catch {
      setOperator(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshToken = useCallback(async () => {
    try {
      await apiFetch("/auth/refresh", { method: "POST" });
    } catch {
      // 갱신 실패 시 로그인 페이지로 — fetchMe가 null 처리
      await fetchMe();
    }
  }, [fetchMe]);

  const startRefreshTimer = useCallback(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    refreshTimer.current = setInterval(refreshToken, REFRESH_INTERVAL);
  }, [refreshToken]);

  const stopRefreshTimer = useCallback(() => {
    if (refreshTimer.current) {
      clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  // 로그인 상태 변경 시 타이머 관리
  useEffect(() => {
    if (operator) {
      startRefreshTimer();
    } else {
      stopRefreshTimer();
    }
    return stopRefreshTimer;
  }, [operator, startRefreshTimer, stopRefreshTimer]);

  const login = async (username: string, password: string) => {
    await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    await fetchMe();
  };

  const logout = async () => {
    stopRefreshTimer();
    await apiFetch("/auth/logout", { method: "POST" });
    setOperator(null);
  };

  return (
    <AuthContext.Provider value={{ operator, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
