"use client";

import { cn } from "@/lib/utils";

type StatusLevel = "ok" | "warning" | "danger" | "info" | "neutral" | "unknown";

interface StatusIndicatorProps {
  status: StatusLevel;
  label?: string;
  size?: "sm" | "md";
}

const STATUS_STYLES: Record<
  StatusLevel,
  { dot: string; animation?: string; label: string }
> = {
  ok: {
    dot: "bg-status-ok",
    animation: "status-pulse-ok",
    label: "text-status-ok",
  },
  warning: {
    dot: "bg-status-warning",
    animation: "animate-pulse",
    label: "text-status-warning",
  },
  danger: {
    dot: "bg-status-danger",
    animation: "status-pulse-danger",
    label: "text-status-danger",
  },
  info: {
    dot: "bg-status-info",
    label: "text-status-info",
  },
  neutral: {
    dot: "bg-status-neutral",
    label: "text-text-muted",
  },
  unknown: {
    dot: "bg-status-neutral",
    label: "text-text-muted",
  },
};

const SIZE_STYLES = {
  sm: { dot: "w-2 h-2", text: "text-xs" },
  md: { dot: "w-2.5 h-2.5", text: "text-sm" },
} as const;

export default function StatusIndicator({
  status,
  label,
  size = "md",
}: StatusIndicatorProps) {
  const style = STATUS_STYLES[status];
  const sizeStyle = SIZE_STYLES[size];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "rounded-full shrink-0",
          sizeStyle.dot,
          style.dot,
          style.animation,
        )}
      />
      {label && (
        <span className={cn(sizeStyle.text, style.label)}>{label}</span>
      )}
    </span>
  );
}
