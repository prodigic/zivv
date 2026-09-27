import React from "react";
import {
  DISCOVERY_TIME_ZONE,
  isWithinLast7LocalDays,
} from "@/lib/discovery.js";
import NewShowBadge from "./NewShowBadge.js";

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
  if (!isWithinLast7LocalDays(event, nowMs ?? Date.now(), timeZone))
    return null;

  return (
    <NewShowBadge
      addedAtEpochMs={createdAtEpochMs}
      timeZone={timeZone}
      className={className}
    />
  );
};

export default NewBadge;
