"use client";

import { Plus, Trash2 } from "lucide-react";
import type { FlagSlotConfig } from "@/types/ops";

const SLOT_DIFFICULTY_OPTIONS = [
  { value: "Easy", label: "Easy" },
  { value: "Medium", label: "Medium" },
  { value: "Hard", label: "Hard" },
] as const;

export function createDefaultFlagSlot(index = 1, points = 100, difficulty: FlagSlotConfig["difficulty"] = "Easy"): FlagSlotConfig {
  return {
    slot_key: `flag-${index}`,
    label: `플래그 ${index}`,
    filename: index === 1 ? "flag.txt" : `flag-${index}.txt`,
    points,
    difficulty,
  };
}

function normalizeSlots(slots: FlagSlotConfig[]): FlagSlotConfig[] {
  const base = slots.length > 0 ? slots : [createDefaultFlagSlot()];
  return base.map((slot, index) => ({
    slot_key: slot.slot_key || `flag-${index + 1}`,
    label: slot.label || `플래그 ${index + 1}`,
    filename: slot.filename || (index === 0 ? "flag.txt" : `flag-${index + 1}.txt`),
    points: Number(slot.points) > 0 ? Number(slot.points) : 100,
    difficulty: slot.difficulty || "Easy",
  }));
}

interface FlagSlotEditorProps {
  slots: FlagSlotConfig[];
  onChange: (slots: FlagSlotConfig[]) => void;
  disabled?: boolean;
}

export default function FlagSlotEditor({
  slots,
  onChange,
  disabled = false,
}: FlagSlotEditorProps) {
  const normalizedSlots = normalizeSlots(slots);
  const totalPoints = normalizedSlots.reduce((sum, slot) => sum + (Number(slot.points) || 0), 0);

  function updateSlot(index: number, patch: Partial<FlagSlotConfig>) {
    onChange(
      normalizedSlots.map((slot, slotIndex) =>
        slotIndex === index ? { ...slot, ...patch } : { ...slot },
      ),
    );
  }

  function addSlot() {
    const nextIndex = normalizedSlots.length + 1;
    onChange([...normalizedSlots, createDefaultFlagSlot(nextIndex, 100, "Easy")]);
  }

  function removeSlot(index: number) {
    if (normalizedSlots.length <= 1) return;
    onChange(normalizedSlots.filter((_, slotIndex) => slotIndex !== index));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-text-primary">플래그 슬롯</p>
          <p className="text-xs text-text-muted">
            각 취약점마다 파일명, 점수, 난이도를 따로 관리합니다. `flag.txt`도 일반 슬롯 중 하나입니다.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">
            총점 <span className="font-semibold text-text-primary">{totalPoints}점</span>
          </div>
          <button
            type="button"
            onClick={addSlot}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            플래그 추가
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {normalizedSlots.map((slot, index) => (
          <div key={`${slot.slot_key ?? "slot"}-${index}`} className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-text-primary">슬롯 {index + 1}</p>
                <p className="text-xs text-text-muted">이 슬롯의 이름, 파일명, 난이도, 점수를 설정합니다.</p>
              </div>
              <button
                type="button"
                onClick={() => removeSlot(index)}
                disabled={disabled || normalizedSlots.length <= 1}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-status-danger hover:bg-status-danger/10 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                삭제
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_200px_120px]">
              <label className="space-y-1.5 md:col-span-3">
                <span className="text-xs font-medium text-text-secondary">취약점 이름</span>
                <input
                  type="text"
                  value={slot.label}
                  onChange={(e) => updateSlot(index, { label: e.target.value })}
                  disabled={disabled}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
                  placeholder="예: 인증 우회"
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-text-secondary">파일명</span>
                <input
                  type="text"
                  value={slot.filename}
                  onChange={(e) => updateSlot(index, { filename: e.target.value })}
                  disabled={disabled}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-sm text-text-primary"
                  placeholder="flag-auth.txt"
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-text-secondary">난이도</span>
                <select
                  value={slot.difficulty}
                  onChange={(e) => updateSlot(index, { difficulty: e.target.value })}
                  disabled={disabled}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
                >
                  {SLOT_DIFFICULTY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1.5 md:max-w-[120px]">
                <span className="text-xs font-medium text-text-secondary">점수</span>
                <input
                  type="number"
                  min={1}
                  value={slot.points}
                  onChange={(e) => updateSlot(index, { points: Math.max(1, Number(e.target.value) || 1) })}
                  disabled={disabled}
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
                />
              </label>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
