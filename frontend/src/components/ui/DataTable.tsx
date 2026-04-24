"use client";

import { cn } from "@/lib/utils";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  isLoading?: boolean;
}

type SortDirection = "asc" | "desc" | null;

interface SortState {
  key: string | null;
  direction: SortDirection;
}

const SKELETON_ROWS = 5;

function getNextDirection(current: SortDirection): SortDirection {
  if (current === null) return "asc";
  if (current === "asc") return "desc";
  return null;
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce(
      (acc, key) =>
        acc !== null && acc !== undefined
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj,
    );
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;

  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }

  return String(a).localeCompare(String(b));
}

export default function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyMessage = "데이터가 없습니다",
  isLoading = false,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>({
    key: null,
    direction: null,
  });

  function handleSort(columnKey: string) {
    setSort((prev) => {
      const nextDirection =
        prev.key === columnKey ? getNextDirection(prev.direction) : "asc";

      return {
        key: nextDirection === null ? null : columnKey,
        direction: nextDirection,
      };
    });
  }

  const sortedData = (() => {
    if (!sort.key || !sort.direction) return data;

    const key = sort.key;
    const dir = sort.direction;

    return [...data].sort((a, b) => {
      const valA = getNestedValue(a, key);
      const valB = getNestedValue(b, key);
      const result = compareValues(valA, valB);
      return dir === "asc" ? result : -result;
    });
  })();

  return (
    <div className="w-full overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse">
        {/* 헤더 */}
        <thead>
          <tr className="bg-bg-tertiary">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "px-4 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider",
                  col.sortable && "cursor-pointer select-none hover:text-text-primary",
                  col.className,
                )}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.sortable && (
                    <span className="inline-flex flex-col -space-y-1">
                      <ChevronUp
                        className={cn(
                          "w-3 h-3",
                          sort.key === col.key && sort.direction === "asc"
                            ? "text-accent"
                            : "text-text-muted/40",
                        )}
                      />
                      <ChevronDown
                        className={cn(
                          "w-3 h-3",
                          sort.key === col.key && sort.direction === "desc"
                            ? "text-accent"
                            : "text-text-muted/40",
                        )}
                      />
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>

        {/* 바디 */}
        <tbody className="divide-y divide-border">
          {/* 로딩 스켈레톤 */}
          {isLoading &&
            Array.from({ length: SKELETON_ROWS }).map((_, rowIdx) => (
              <tr key={`skeleton-${rowIdx}`}>
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-3">
                    <div className="h-4 w-3/4 animate-pulse rounded bg-bg-tertiary" />
                  </td>
                ))}
              </tr>
            ))}

          {/* 빈 상태 */}
          {!isLoading && sortedData.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-12 text-center text-sm text-text-muted"
              >
                {emptyMessage}
              </td>
            </tr>
          )}

          {/* 데이터 행 */}
          {!isLoading &&
            sortedData.map((row) => (
              <tr
                key={keyExtractor(row)}
                className={cn(
                  "transition-colors",
                  onRowClick &&
                    "cursor-pointer hover:bg-bg-tertiary/50",
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "px-4 py-3 text-sm text-text-primary",
                      col.className,
                    )}
                  >
                    {col.render
                      ? col.render(row)
                      : String(
                          getNestedValue(row, col.key) ?? "",
                        )}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
