/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import EventAtlasCard from "@/components/ui/EventAtlasCard.js";
import type { Artist, Event, Venue } from "@/types/events.js";

afterEach(cleanup);
const venue = {
  id: 1,
  name: "Test Hall",
  slug: "test-hall",
  website: "https://example.com/",
  address: "123 Main Street",
  city: "San Francisco",
  mapLocation: {
    latitude: 37.77,
    longitude: -122.42,
    precision: "address",
    sourceUrl: "https://example.com/location",
  },
} as Venue;
const event = {
  id: 1,
  dateEpochMs: Date.parse("2026-10-06T12:00:00Z"),
  priceMin: 20,
  priceMax: 30,
  status: "confirmed",
  ageRestriction: "all-ages",
  addedDateProvenance: "unknown",
  ticketUrl: "https://example.com/tickets",
  description: "An evening of live music",
  notes: "Doors at six",
} as Event;
const support = { id: 2, name: "Support act", slug: "support-act" } as Artist;

it("keeps website, support and ticket navigation alongside show details and attributed map", () => {
  render(
    <MemoryRouter>
      <EventAtlasCard
        event={event}
        venue={venue}
        headlinerName="Headliner"
        supportingArtists={[support]}
      />
    </MemoryRouter>
  );
  expect(screen.getByRole("link", { name: "Test Hall" })).toHaveAttribute(
    "href",
    venue.website
  );
  expect(
    screen.getByRole("link", { name: "Test Hall" }).querySelector("svg")
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Support act" })).toHaveAttribute(
    "href",
    "/artists/support-act"
  );
  expect(screen.getByRole("link", { name: "Tickets ↗" })).toHaveAttribute(
    "href",
    event.ticketUrl
  );
  expect(screen.getByText("$20–$30")).toBeInTheDocument();
  expect(screen.getByText("Doors at six")).toBeInTheDocument();
  expect(screen.getByText("An evening of live music")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "© OpenStreetMap contributors" })
  ).toBeInTheDocument();
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByRole("link", { name: /Map preview unavailable/ })
  ).toHaveAttribute(
    "href",
    expect.stringContaining("openstreetmap.org/?mlat=")
  );
  expect(screen.getByRole("link", { name: "Test Hall" })).toBeInTheDocument();
});

it("handles unmapped venues without a website and shows cancellation ahead of sold-out tags", () => {
  render(
    <MemoryRouter>
      <EventAtlasCard
        event={{ ...event, status: "cancelled", tags: ["sold-out"] }}
        venue={{ ...venue, website: undefined, mapLocation: undefined }}
        headlinerName="Headliner"
        supportingArtists={[]}
      />
    </MemoryRouter>
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("link", { name: "Test Hall" })).toHaveAttribute(
    "href",
    "/venues/test-hall"
  );
  expect(
    screen.getByRole("link", { name: /Location not mapped/ })
  ).toHaveAttribute(
    "href",
    expect.stringContaining("openstreetmap.org/search?query=")
  );
  expect(screen.getByText("CANCELLED")).toBeInTheDocument();
  expect(screen.queryByText("SOLD OUT")).toBeNull();
});
