/**
 * Date range slider — dual-handle with named checkpoints.
 * Default: today → +7 days (this week).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFilterStore } from "@/stores/filterStore";

// Checkpoint offsets in days from today
const CHECKPOINTS = [0, 2, 7, 14, 30, 90, 180];
const LABELS = ["Today", "+2d", "Week", "+2wk", "Month", "+3mo", "+6mo"];

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function toISO(d: Date): string {
  return d.toISOString().split("T")[0];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

interface DatePaginationProps {
  className?: string;
}

export const DatePagination: React.FC<DatePaginationProps> = ({ className = "" }) => {
  const { filters, updateFilter, clearFilter } = useFilterStore();
  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const maxOffset = CHECKPOINTS[CHECKPOINTS.length - 1];

  // Derive current start/end offsets from filter store
  const startOffset = useMemo(() => {
    if (!filters.dateRange?.startDate) return 0;
    const diff = Math.round((new Date(filters.dateRange.startDate).getTime() - today.getTime()) / 86400000);
    return clamp(diff, 0, maxOffset);
  }, [filters.dateRange?.startDate, today, maxOffset]);

  const endOffset = useMemo(() => {
    if (!filters.dateRange?.endDate) return 7;
    const diff = Math.round((new Date(filters.dateRange.endDate).getTime() - today.getTime()) / 86400000);
    return clamp(diff, 0, maxOffset);
  }, [filters.dateRange?.endDate, today, maxOffset]);

  // Initialize to this week if no date filter set
  useEffect(() => {
    if (!filters.dateRange?.startDate && !filters.dateRange?.endDate && !filters.dates?.length) {
      updateFilter("dateRange", { startDate: toISO(today), endDate: toISO(addDays(today, 7)) });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // Logarithmic scale so near-term days (0-14) get ~60% of the track width
  const logMax = Math.log1p(maxOffset);
  const offsetToPercent = (offset: number) => (Math.log1p(offset) / logMax) * 100;
  const percentToOffset = (pct: number) => Math.round(Math.expm1(clamp(pct, 0, 100) / 100 * logMax));

  // Snap to nearest checkpoint
  const snapToCheckpoint = (offset: number) => {
    return CHECKPOINTS.reduce((best, cp) =>
      Math.abs(cp - offset) < Math.abs(best - offset) ? cp : best
    );
  };

  const getOffsetFromEvent = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const { left, width } = track.getBoundingClientRect();
    const pct = clamp((clientX - left) / width, 0, 1) * 100;
    return percentToOffset(pct);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxOffset]);

  const applyOffsets = useCallback((s: number, e: number) => {
    const start = snapToCheckpoint(Math.min(s, e));
    const end = snapToCheckpoint(Math.max(s, e));
    if (start === 0 && end === maxOffset) {
      clearFilter("dateRange");
    } else {
      updateFilter("dateRange", {
        startDate: toISO(addDays(today, start)),
        endDate: toISO(addDays(today, end)),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today, maxOffset]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging) return;
    const offset = getOffsetFromEvent(e.clientX);
    if (dragging === "start") applyOffsets(offset, endOffset);
    else applyOffsets(startOffset, offset);
  }, [dragging, getOffsetFromEvent, startOffset, endOffset, applyOffsets]);

  const handleMouseUp = useCallback(() => setDragging(null), []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!dragging) return;
    const offset = getOffsetFromEvent(e.touches[0].clientX);
    if (dragging === "start") applyOffsets(offset, endOffset);
    else applyOffsets(startOffset, offset);
  }, [dragging, getOffsetFromEvent, startOffset, endOffset, applyOffsets]);

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleMouseUp);
    };
  }, [dragging, handleMouseMove, handleMouseUp, handleTouchMove]);

  const startPct = offsetToPercent(startOffset);
  const endPct = offsetToPercent(endOffset);

  const startLabel = startOffset === 0 ? "Today" : toISO(addDays(today, startOffset)).slice(5).replace("-", "/");
  const endLabel = toISO(addDays(today, endOffset)).slice(5).replace("-", "/");

  return (
    <div className={`select-none ${className}`}>
      {/* Range label */}
      <div className="flex items-center justify-between mb-2 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium text-gray-700 dark:text-gray-200">{startLabel}</span>
        <span className="text-gray-400 dark:text-gray-500">→</span>
        <span className="font-medium text-gray-700 dark:text-gray-200">{endLabel}</span>
        {(filters.dateRange?.startDate || filters.dateRange?.endDate) && (
          <button
            onClick={() => clearFilter("dateRange")}
            className="ml-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            ✕
          </button>
        )}
      </div>

      {/* Track */}
      <div ref={trackRef} className="relative h-6 flex items-center cursor-pointer mx-2">
        {/* Background */}
        <div className="absolute inset-x-0 h-1.5 bg-gray-200 dark:bg-gray-600 rounded-full" />

        {/* Active range fill */}
        <div
          className="absolute h-1.5 bg-blue-500 dark:bg-blue-400 rounded-full"
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
        />

        {/* Checkpoint ticks */}
        {CHECKPOINTS.map((cp, i) => {
          const pct = offsetToPercent(cp);
          const inside = cp >= startOffset && cp <= endOffset;
          return (
            <div
              key={cp}
              className="absolute flex flex-col items-center"
              style={{ left: `${pct}%`, transform: "translateX(-50%)" }}
            >
              <div className={`w-1.5 h-1.5 rounded-full ${inside ? "bg-blue-500 dark:bg-blue-400" : "bg-gray-300 dark:bg-gray-500"}`} />
              <span className="mt-1 text-[9px] leading-none text-gray-400 dark:text-gray-500 whitespace-nowrap">{LABELS[i]}</span>
            </div>
          );
        })}

        {/* Start handle */}
        <div
          className="absolute w-4 h-4 bg-white dark:bg-gray-200 border-2 border-blue-500 rounded-full shadow cursor-grab active:cursor-grabbing z-10 -translate-x-1/2"
          style={{ left: `${startPct}%` }}
          onMouseDown={() => setDragging("start")}
          onTouchStart={() => setDragging("start")}
        />

        {/* End handle */}
        <div
          className="absolute w-4 h-4 bg-white dark:bg-gray-200 border-2 border-blue-500 rounded-full shadow cursor-grab active:cursor-grabbing z-10 -translate-x-1/2"
          style={{ left: `${endPct}%` }}
          onMouseDown={() => setDragging("end")}
          onTouchStart={() => setDragging("end")}
        />
      </div>
    </div>
  );
};
