import React from "react";
import {
  DISCOVERY_TIME_ZONE,
  formatAddedDateLabel,
  isWithinLast7LocalDays,
} from "@/lib/discovery.js";

interface NewBadgeProps {
  createdAtEpochMs?: number | null;
  addedDateProvenance?: string | null;
  /** Kept for old callsites and cached layouts; date-added windows no longer use it. */
  latestIngestionDate?: string;
  /** Optional clock injection makes the seven-local-day rule deterministic in tests. */
  nowMs?: number;
  timeZone?: string;
  className?: string;
}

const NewBadge: React.FC<NewBadgeProps> = ({
  createdAtEpochMs,
  addedDateProvenance,
  nowMs,
  timeZone = DISCOVERY_TIME_ZONE,
  className = "",
}) => {
  const event = { createdAtEpochMs, addedDateProvenance };
  if (!isWithinLast7LocalDays(event, nowMs ?? Date.now(), timeZone)) return null;

  const label = formatAddedDateLabel(createdAtEpochMs, timeZone);
  if (!label) return null;

  return (
    <span
      className={`text-gray-400 dark:text-gray-300 shrink-0 leading-none inline-flex items-center gap-1 ${className}`}
      title={label}
      aria-label={label}
    >
      <span aria-hidden="true">✦</span>
      <span>{label}</span>
    </span>
  );
};

export default NewBadge;
