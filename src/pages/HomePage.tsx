/** Weekly discovery: local artists first, then venues in the same date range. */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.tsx";
import { DatePagination } from "@/components/ui/DatePagination.tsx";
import { localDateKey } from "@/lib/discovery.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import LocalArtistsPage from "./LocalArtistsPage.tsx";
import VenuesPage from "./VenuesPage.tsx";

const HomePage: React.FC = () => {
  const updateFilter = useFilterStore((state) => state.updateFilter);
  const [ready, setReady] = useState(false);
  const week = useMemo(() => {
    const startDate =
      localDateKey(Date.now()) ?? new Date().toISOString().slice(0, 10);
    const end = new Date(`${startDate}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 7);
    return { startDate, endDate: end.toISOString().slice(0, 10) };
  }, []);

  useEffect(() => {
    updateFilter("dateRange", week);
    setReady(true);
  }, [updateFilter, week]);

  return (
    <ContentArea
      title="This Week"
      subtitle="Discover local artists and Bay Area venues with upcoming shows."
      actions={
        <Link
          to="/shows"
          className="text-sm font-medium text-purple-600 dark:text-purple-400"
        >
          All events →
        </Link>
      }
    >
      {ready && (
        <>
          <DatePagination className="mb-8" />
          <div className="space-y-12">
            <LocalArtistsPage embedded />
            <VenuesPage embedded />
          </div>
        </>
      )}
    </ContentArea>
  );
};

export default HomePage;
