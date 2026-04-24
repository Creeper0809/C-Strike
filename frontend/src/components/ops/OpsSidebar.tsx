"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/providers/AuthProvider";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "@/lib/constants";
import {
  LayoutDashboard, Shield, Calendar, Rocket, Target,
  Box, Ticket, AlertTriangle, ClipboardList, Settings,
  LogOut, ChevronLeft, Sun, Moon, Trophy, Flag, Network, MessageSquare, Users, Bot, UserCog,
} from "lucide-react";
import { useState } from "react";
import { useTheme } from "@/providers/ThemeProvider";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard, Shield, Calendar, Rocket, Target,
  Box, Ticket, AlertTriangle, ClipboardList, Settings, Trophy,
  Flag, Network, MessageSquare, Users, Bot, UserCog,
};

export function OpsSidebar() {
  const pathname = usePathname();
  const { operator, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-border bg-bg-secondary transition-all duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        {!collapsed && (
          <span className="text-sm font-semibold tracking-tight text-accent">C-STRIKE OPS</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
        >
          <ChevronLeft className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          if ("adminOnly" in item && item.adminOnly && operator?.role !== "admin") return null;
          const Icon = ICON_MAP[item.icon];
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent/10 text-accent font-medium"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary",
                item.icon === "AlertTriangle" && "text-status-danger hover:text-status-danger"
              )}
              title={collapsed ? item.label : undefined}
            >
              {Icon && <Icon className="h-4 w-4 shrink-0" />}
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3 space-y-2">
        <button
          onClick={toggleTheme}
          className={cn(
            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors",
            collapsed && "justify-center px-0"
          )}
          title={theme === "dark" ? "라이트 모드" : "다크 모드"}
        >
          {theme === "dark" ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
          {!collapsed && <span>{theme === "dark" ? "라이트 모드" : "다크 모드"}</span>}
        </button>
        <div className={cn("flex items-center gap-2", collapsed && "justify-center")}>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/20 text-xs font-bold text-accent">
            {operator?.display_name?.[0] || "?"}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="truncate text-xs font-medium">{operator?.display_name}</p>
              <p className="truncate text-[10px] text-text-muted">{operator?.role}</p>
            </div>
          )}
          <button
            onClick={logout}
            className="rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-status-danger"
            title="로그아웃"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
