import React from "react";

interface NewBadgeProps {
  createdAtEpochMs: number;
  latestIngestionDate: string; // YYYY-MM-DD
  className?: string;
}

const NewBadge: React.FC<NewBadgeProps> = ({ createdAtEpochMs, latestIngestionDate, className = "" }) => {
  const createdDay = new Date(createdAtEpochMs).toISOString().split("T")[0];
  if (createdDay !== latestIngestionDate) return null;

  return (
    <span className={`text-gray-400 dark:text-gray-300 shrink-0 ${className}`} title="Just added">
      ✦
    </span>
  );
};

export default NewBadge;
