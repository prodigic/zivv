import React from "react";
import { formatAddedDateLabel } from "@/lib/discovery.js";

/** Compact new-show marker; the added date remains available on hover. */
const NewShowBadge: React.FC<{
  addedAtEpochMs?: number | null;
  timeZone?: string;
  className?: string;
}> = ({ addedAtEpochMs, timeZone, className = "" }) => {
  return (
    <span
      role="img"
      aria-label="Recently added"
      title={formatAddedDateLabel(addedAtEpochMs, timeZone) ?? "Recently added"}
      className={`shrink-0 text-sm ${className}`}
    >
      🆕
    </span>
  );
};

export default NewShowBadge;
