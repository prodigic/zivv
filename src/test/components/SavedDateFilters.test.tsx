/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useFilterStore } from "@/stores/filterStore";
import { DatePagination } from "@/components/ui/DatePagination";
import type { EventFilters } from "@/types/events";

async function restore(filters: Partial<EventFilters>) {
  localStorage.setItem(
    "zivv-filters",
    JSON.stringify({
      state: { filters, searchQuery: "", sortBy: "date", sortOrder: "asc" },
      version: 0,
    })
  );
  await useFilterStore.persist.rehydrate();
  return useFilterStore.getState();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T19:00:00Z"));
  useFilterStore.getState().clearFilters();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe("saved date filters", () => {
  it("expires last week's saved dates while retaining the city selection", async () => {
    const state = await restore({
      cities: ["Oakland"],
      dates: ["2026-09-19", "2026-09-20"],
      dateRange: { startDate: "2026-09-19", endDate: "2026-09-26" },
    });
    expect(state.filters.dateRange).toEqual({});
    expect(state.filters.dates).toEqual([]);
    expect(state.filters.cities).toEqual(["Oakland"]);
    expect(state.hasActiveFilters).toBe(true);
    expect(state.activeFilterCount).toBe(1);
  });

  it("preserves today's and future selections and restores their active indicator", async () => {
    const dateRange = { startDate: "2026-09-26", endDate: "2026-09-27" };
    const state = await restore({ dateRange, dates: ["2026-09-28"] });
    expect(state.filters.dateRange).toEqual(dateRange);
    expect(state.filters.dates).toEqual(["2026-09-28"]);
    expect(state.activeFilterCount).toBe(2);
    expect(state.hasActiveFilters).toBe(true);
  });

  it("opening and reopening the date control never silently applies a default week", () => {
    const first = render(<DatePagination />);
    expect(useFilterStore.getState().filters.dateRange).toEqual({});
    first.unmount();
    useFilterStore
      .getState()
      .updateFilter("dateRange", { endDate: "2026-10-04" });
    const second = render(<DatePagination />);
    fireEvent.click(screen.getByRole("button", { name: "Clear date range" }));
    second.unmount();
    render(<DatePagination />);
    expect(useFilterStore.getState().filters.dateRange).toEqual({});
    expect(
      screen.queryByRole("button", { name: "Clear date range" })
    ).toBeNull();
  });

  it("shows the actual selected past date instead of relabeling it Today", () => {
    useFilterStore.getState().updateFilter("dateRange", {
      startDate: "2026-09-19",
      endDate: "2026-09-20",
    });
    render(<DatePagination />);
    expect(screen.getByText("09/19")).toBeInTheDocument();
    expect(screen.getByText("09/20")).toBeInTheDocument();
  });
});
