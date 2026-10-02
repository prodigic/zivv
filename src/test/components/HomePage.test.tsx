/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import HomePage from "@/pages/HomePage.tsx";
import { SideNavigation } from "@/components/layout/SideNavigation.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import type { Artist, ArtistUpcomingEvent, Venue } from "@/types/events.ts";

const initialState = useAppStore.getState();
const show = (id: number, date: string, venueId = 1): ArtistUpcomingEvent =>
  ({
    id,
    slug: `show-${id}`,
    dateEpochMs: Date.parse(`${date}T12:00:00Z`),
    venueId,
    venueName: venueId === 1 ? "Weekly Venue" : "Later Venue",
    venueCity: "Oakland",
    headlinerName: `Headliner ${id}`,
    isFree: false,
    isSoldOut: false,
    createdAtEpochMs: Date.parse("2026-09-30T19:00:00Z"),
    addedDateProvenance: "observed",
  }) as ArtistUpcomingEvent;
const yesterday = show(10, "2026-09-30");
const first = show(11, "2026-10-02");
const boundary = show(12, "2026-10-08");
const later = show(13, "2026-10-09", 2);
const artist = (
  id: number,
  name: string,
  upcomingEvents: ArtistUpcomingEvent[]
) => ({ id, name, slug: `artist-${id}`, upcomingEvents }) as Artist;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T19:00:00Z"));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  sessionStorage.clear();
  useFilterStore.getState().clearFilters();
  useFilterStore.getState().clearSearch();
  const artists = [
    artist(1, "Local Support", [yesterday, first, boundary, later]),
    artist(2, "Touring Act", [first]),
    artist(3, "Later Local", [later]),
    artist(4, "Excluded Act", [first]),
  ];
  const venues = [
    {
      id: 1,
      name: "Weekly Venue",
      city: "Oakland",
      slug: "weekly-venue",
      upcomingEvents: [yesterday, first, boundary],
    } as Venue,
    {
      id: 2,
      name: "Later Venue",
      city: "Oakland",
      slug: "later-venue",
      upcomingEvents: [later],
    } as Venue,
  ];
  useAppStore.setState({
    ...initialState,
    artists: new Map(artists.map((a) => [a.id, a])),
    venues: new Map(venues.map((v) => [v.id, v])),
    localArtistList: new Set(["local support", "later local", "excluded act"]),
    localArtistExclude: new Set(["excluded act"]),
    events: new Map(),
    showUpcomingOnly: false,
    loading: { ...initialState.loading, artists: "success", venues: "success" },
    initialize: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  cleanup();
  useAppStore.setState(initialState);
  useFilterStore.getState().clearFilters();
  useFilterStore.getState().clearSearch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const openHome = () =>
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );

describe("weekly landing page", () => {
  it("shows upcoming acts in the sidebar before full event chunks have loaded", () => {
    const { container } = render(
      <MemoryRouter>
        <SideNavigation isOpen onClose={() => {}} />
        <HomePage />
      </MemoryRouter>
    );
    expect(useAppStore.getState().events.size).toBe(0);
    expect(container.querySelector("aside")).toHaveTextContent("Headliner 11");
    expect(container.querySelector("aside")).not.toHaveTextContent(
      "No upcoming events"
    );
  });
  it("defaults both sections to one week, shows verified local support artists first, and trims every card to that window", () => {
    useFilterStore.getState().updateFilter("dateRange", {
      startDate: "2026-09-01",
      endDate: "2026-12-31",
    });
    const { container } = openHome();
    expect(useFilterStore.getState().filters.dateRange).toEqual({
      startDate: "2026-10-01",
      endDate: "2026-10-08",
    });
    const locals = screen.getByRole("region", { name: "Local Artists" });
    const venues = screen.getByRole("region", { name: "Venues" });
    expect(
      [...container.querySelectorAll("h2")].map((h) => h.textContent)
    ).toEqual(["Local Artists", "Venues"]);
    expect(
      within(locals).getByRole("heading", { name: "Local Support" })
    ).toBeInTheDocument();
    expect(within(locals).getByText("2 shows · 1 venue")).toBeInTheDocument();
    expect(
      within(locals).queryByRole("heading", { name: "Touring Act" })
    ).not.toBeInTheDocument();
    expect(within(locals).queryByText("Later Local")).not.toBeInTheDocument();
    expect(within(locals).queryByText("Excluded Act")).not.toBeInTheDocument();
    expect(
      within(venues).getByRole("heading", { name: "Weekly Venue" })
    ).toBeInTheDocument();
    expect(
      within(venues).queryByRole("heading", { name: "Later Venue" })
    ).not.toBeInTheDocument();
    const links = [...container.querySelectorAll('a[href^="/events/"]')];
    expect(links.length).toBeGreaterThan(0);
    expect(
      links.every((a) =>
        ["/events/show-11", "/events/show-12"].includes(a.getAttribute("href")!)
      )
    ).toBe(true);
    expect(within(venues).getAllByRole("link")[0]).toHaveAttribute(
      "href",
      "/events/show-11"
    );
    expect(
      screen.getAllByRole("button", { name: "Clear date range" })
    ).toHaveLength(1);
    expect(screen.getByRole("link", { name: "All events →" })).toHaveAttribute(
      "href",
      "/shows"
    );
  });

  it("updates artists and venues together when the shared range changes", () => {
    openHome();
    act(() =>
      useFilterStore.getState().updateFilter("dateRange", {
        startDate: "2026-10-09",
        endDate: "2026-10-09",
      })
    );
    const locals = screen.getByRole("region", { name: "Local Artists" });
    const venues = screen.getByRole("region", { name: "Venues" });
    expect(
      within(locals).getByRole("heading", { name: "Later Local" })
    ).toBeInTheDocument();
    expect(
      within(venues).getByRole("heading", { name: "Later Venue" })
    ).toBeInTheDocument();
    expect(
      within(venues).queryByRole("heading", { name: "Weekly Venue" })
    ).not.toBeInTheDocument();
    act(() =>
      useFilterStore.getState().updateFilter("dateRange", {
        startDate: "2026-11-01",
        endDate: "2026-11-07",
      })
    );
    expect(
      within(locals).getByText("No local artists playing in this date range.")
    ).toBeInTheDocument();
    expect(
      within(venues).getByText("No venues with shows in this date range.")
    ).toBeInTheDocument();
  });

  it("keeps venues reachable when the local artist list needs pagination", () => {
    useAppStore.setState({
      artists: new Map(
        Array.from({ length: 31 }, (_, i) => {
          const a = artist(i + 1, `Local ${i}`, [first]);
          return [a.id, a];
        })
      ),
      localArtistList: new Set(
        Array.from({ length: 31 }, (_, i) => `local ${i}`)
      ),
    });
    openHome();
    const locals = screen.getByRole("region", { name: "Local Artists" });
    expect(within(locals).getAllByRole("heading", { level: 3 })).toHaveLength(
      30
    );
    expect(screen.getByRole("region", { name: "Venues" })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show more local artists" })
    );
    expect(within(locals).getAllByRole("heading", { level: 3 })).toHaveLength(
      31
    );
  });

  it("keeps the full seven-day range across month boundaries", () => {
    vi.setSystemTime(new Date("2026-10-31T19:00:00Z"));
    openHome();
    expect(useFilterStore.getState().filters.dateRange).toEqual({
      startDate: "2026-10-31",
      endDate: "2026-11-07",
    });
  });
});
