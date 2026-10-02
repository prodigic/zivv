/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { useFilterStore } from "@/stores/filterStore";
import type { Venue } from "@/types/events";
import VenuesPage from "@/pages/VenuesPage";

const initialState = useAppStore.getState();

function venue(id: number, name: string, city: string, count: number): Venue {
  return {
    id,
    name,
    city,
    upcomingEvents: Array.from({ length: count }, (_, index) => ({
      id: id * 10 + index,
      slug: `show-${id}-${index}`,
      dateEpochMs: new Date(2026, 9, 2, 19).getTime(),
      headlinerName: `Band ${id}-${index}`,
    })),
  } as Venue;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1, 12));
  sessionStorage.clear();
  useFilterStore.getState().clearFilters();
  const venues = [
    venue(1, "Hopmonk Tavern", "Sebastopol", 3),
    venue(2, "Smiley's", "Bolinas", 2),
    venue(3, "Hopmonk", "Sebastopol", 1),
  ];
  useAppStore.setState({
    venues: new Map(venues.map((v) => [v.id, v])),
    loading: { ...initialState.loading, venues: "success" },
    errors: { ...initialState.errors, venues: null },
    showUpcomingOnly: true,
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState(initialState);
  useFilterStore.getState().clearFilters();
  vi.useRealTimers();
});

it("keeps each city in one section and renders each venue once after selecting one week", () => {
  const { container } = render(
    <MemoryRouter>
      <VenuesPage />
    </MemoryRouter>
  );
  act(() =>
    useFilterStore.getState().updateFilter("dateRange", {
      startDate: "2026-10-01",
      endDate: "2026-10-08",
    })
  );
  const cityLabels = [...container.querySelectorAll("span.uppercase")].map(
    (el) => el.textContent
  );
  expect(cityLabels).toEqual(["Bolinas", "Sebastopol"]);
  expect(
    screen.getAllByRole("heading", { name: "Hopmonk Tavern", exact: true })
  ).toHaveLength(1);
  expect(container.querySelectorAll(".venue-card")).toHaveLength(3);
});
