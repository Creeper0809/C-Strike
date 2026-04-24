"use client";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  status?: "ok" | "warning" | "danger" | "info" | "neutral";
  trend?: { value: number; label: string };
  className?: string;
}

const STATUS_DOT_STYLES: Record<string, string> = {
  ok: "bg-status-ok",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
  info: "bg-status-info",
  neutral: "bg-status-neutral",
};

export default function StatCard({
  title,
  value,
  icon,
  status,
  trend,
  className,
}: StatCardProps) {
  const isPositive = trend && trend.value > 0;
  const isNegative = trend && trend.value < 0;

  return (
    <div
      className={cn(
        "relative bg-bg-secondary border border-border rounded-xl p-5",
        className,
      )}
    >
      {/* 상단: 제목 + 상태 도트 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary uppercase tracking-wider">
            {title}
          </span>
          {status && (
            <span
              className={cn(
                "w-2 h-2 rounded-full shrink-0",
                STATUS_DOT_STYLES[status],
              )}
            />
          )}
        </div>
        {icon && (
          <span className="text-text-muted">{icon}</span>
        )}
      </div>

      {/* 중앙: 값 */}
      <p className="mt-3 text-3xl font-bold font-mono text-text-primary">
        {value}
      </p>

      {/* 하단: 트렌드 */}
      {trend && (
        <div className="mt-2 flex items-center gap-1">
          {isPositive && (
            <span className="text-status-ok text-xs font-medium">
              ▲ {trend.value}%
            </span>
          )}
          {isNegative && (
            <span className="text-status-danger text-xs font-medium">
              ▼ {Math.abs(trend.value)}%
            </span>
          )}
          {!isPositive && !isNegative && (
            <span className="text-text-muted text-xs font-medium">
              — {trend.value}%
            </span>
          )}
          <span className="text-xs text-text-muted">{trend.label}</span>
        </div>
      )}
    </div>
  );
}
