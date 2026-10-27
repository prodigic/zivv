/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
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

it("keeps official poster links separate from internal show navigation", () => {
  const storeVenues = useAppStore.getState().venues;
  const first = [...storeVenues.values()][0];
  first.upcomingEvents[0].poster = {
    imageUrl: "https://venue.example/flyer.jpg",
    eventUrl: "https://venue.example/show",
    kind: "poster",
    checkedOn: "2026-10-10",
  };
  const { container } = render(
    <MemoryRouter>
      <VenuesPage />
    </MemoryRouter>
  );
  const poster = screen.getByRole("link", { name: /View Band 1-0 poster/ });
  expect(poster).toHaveAttribute("href", "https://venue.example/show");
  expect(container.querySelector("a a")).toBeNull();
  expect(
    poster.parentElement?.querySelector('a[href="/events/show-1-0"]')
  ).toBeTruthy();
  poster.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(poster);
  expect(
    screen.getByRole("heading", { name: "Hopmonk Tavern", exact: true })
  ).toBeVisible();
});

it("keeps artwork aligned and show details available for every row in a venue with posters", () => {
  const first = [...useAppStore.getState().venues.values()][0];
  first.upcomingEvents[0].poster = {
    imageUrl: "https://venue.example/flyer.jpg",
    eventUrl: "https://venue.example/show",
    kind: "poster",
    checkedOn: "2026-10-10",
  };
  first.upcomingEvents[0].priceMin = 20;
  first.upcomingEvents[1].isFree = true;

  const { container } = render(
    <MemoryRouter>
      <VenuesPage />
    </MemoryRouter>
  );
  const card = screen
    .getByRole("heading", {
      name: "Hopmonk Tavern",
      exact: true,
    })
    .closest(".venue-card");
  const rows = card?.querySelectorAll(".border-t > div");
  expect(rows).toHaveLength(3);
  expect(
    rows?.[0].querySelector('a[aria-label^="View Band 1-0 poster"]')
  ).toBeTruthy();
  expect(rows?.[1].querySelector('[aria-hidden="true"]')).toBeTruthy();
  expect(rows?.[2].querySelector('[aria-hidden="true"]')).toBeTruthy();

  for (const row of rows ?? []) {
    expect(row).toHaveClass("grid");
    const eventLink = row.querySelector("a[href^='/events/']");
    expect(eventLink).toHaveTextContent(/Oct 2/);
    expect(eventLink).toHaveTextContent(/Band/);
  }
  expect(rows?.[0].querySelector('[title="$20"]')).toBeTruthy();
  expect(rows?.[1].querySelector('[title="Free"]')).toBeTruthy();
  expect(container.querySelectorAll(".venue-card")).toHaveLength(3);
});

it("lets event links use the full row when the venue has no artwork", () => {
  const { container } = render(
    <MemoryRouter>
      <VenuesPage />
    </MemoryRouter>
  );
  const card = screen
    .getByRole("heading", {
      name: "Smiley's",
      exact: true,
    })
    .closest(".venue-card");
  const rows = card?.querySelectorAll(".border-t > div");

  expect(rows).toHaveLength(2);
  for (const row of rows ?? []) {
    expect(row).toHaveClass("grid-cols-1");
    expect(row.querySelector("[aria-hidden='true']")).toBeNull();
    expect(row.querySelector("a[href^='/events/']")).toBeInTheDocument();
  }
  expect(container.querySelectorAll(".venue-card")).toHaveLength(3);
});

it("reserves poster slots for posterless rows in mixed-artwork venues only", () => {
  const storeVenues = useAppStore.getState().venues;
  const first = [...storeVenues.values()][0];
  first.upcomingEvents[0].poster = {
    imageUrl: "https://venue.example/flyer.jpg",
    eventUrl: "https://venue.example/show",
    kind: "poster",
    checkedOn: "2026-10-10",
  };

  const { container } = render(
    <MemoryRouter>
      <VenuesPage />
    </MemoryRouter>
  );
  const row = (slug: string) =>
    container.querySelector(`.venue-card .border-t a[href="/events/${slug}"]`)
      ?.parentElement;
  const artworkRow = row("show-1-0");
  const posterlessRow = row("show-1-1");
  const allPosterlessVenueRow = row("show-2-0");

  expect(artworkRow?.firstElementChild).toHaveAttribute(
    "href",
    "https://venue.example/show"
  );
  expect(posterlessRow?.firstElementChild).toMatchObject({
    tagName: "SPAN",
    className: expect.stringContaining("h-28 w-20"),
  });
  expect(posterlessRow?.firstElementChild).toHaveAttribute(
    "aria-hidden",
    "true"
  );
  expect(allPosterlessVenueRow?.firstElementChild).toHaveAttribute(
    "href",
    "/events/show-2-0"
  );
});
