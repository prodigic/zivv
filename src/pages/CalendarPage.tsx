/**
 * Calendar page with month/week/agenda views
 */

import React from "react";
import { ContentArea } from "@/components/layout/AppShell.js";
import { CalendarSkeleton } from "@/components/ui/LoadingSpinner.js";

interface CalendarPageProps {
  view: "month" | "week" | "agenda";
}

const CalendarPage: React.FC<CalendarPageProps> = ({ view }) => {
  const titles = {
    month: "Calendar - Month View",
    week: "Calendar - Week View",
    agenda: "Calendar - Agenda View",
  };

  return (
    <ContentArea title={titles[view]} subtitle="View events in calendar format">
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="text-center text-gray-600 dark:text-gray-300 mb-4">
          Calendar view will be implemented in Phase 8
        </div>
        <CalendarSkeleton />
      </div>
    </ContentArea>
  );
};

export default CalendarPage;
