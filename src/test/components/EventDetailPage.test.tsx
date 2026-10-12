/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EventDetailPage from "@/pages/EventDetailPage.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import type { Artist, Event, Venue } from "@/types/events.ts";
import type { DataIndexes, DataManifest } from "@/types/data.ts";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  useAppStore.setState(initial);
});

describe("retired event links", () => {
  it.each([
    "2026-10-02-death-from-above-the-uc-theater",
    "2026-10-02-death-from-above-1979-the-uc-theater",
    "2027-02-11-death-from-above-1979-august-hall",
  ])("loads the current month for %s on a cold event load", async (slug) => {
    const event = {
      id: 1992667217,
      slug: "2026-10-02-death-from-above-the-uc-theater",
      date: "2027-02-11",
      dateEpochMs: Date.parse("2027-02-11T12:00:00Z"),
      headlinerArtistId: 1,
      artistIds: [1],
      venueId: 2,
      status: "confirmed",
      createdAtEpochMs: Date.parse("2026-05-08T12:00:00Z"),
    } as Event;
    const loadChunk = vi.fn(async (chunkId: string) => {
      if (chunkId === "2027-02") {
        useAppStore.setState({ events: new Map([[event.id, event]]) });
      }
    });
    useAppStore.setState({
      ...initial,
      events: new Map(),
      artists: new Map([
        [
          1 as Artist["id"],
          {
            id: 1,
            name: "Death From Above 1979",
            slug: "death-from-above-1979",
            upcomingEvents: [],
          } as Artist,
        ],
      ]),
      venues: new Map([
        [
          2 as Venue["id"],
          {
            id: 2,
            name: "August Hall",
            slug: "august-hall",
            city: "San Francisco",
            website: "https://www.augusthallsf.com/",
            upcomingEvents: [],
          } as Venue,
        ],
      ]),
      indexes: {
        eventSlugRedirects: {
          [slug]: { eventId: event.id, chunkId: "2027-02" },
        },
      } as DataIndexes,
      manifest: {
        chunks: { events: [{ chunkId: "2026-10" }, { chunkId: "2027-02" }] },
      } as DataManifest,
      loading: {
        ...initial.loading,
        artists: "success",
        venues: "success",
        indexes: "success",
      },
      loadedChunks: new Set(),
      loadChunk,
    });
    render(
      <MemoryRouter initialEntries={[`/events/${slug}`]}>
        <Routes>
          <Route path="/events/:slug" element={<EventDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole("heading", {
      name: "Death From Above 1979",
      level: 1,
    });
    await waitFor(() => expect(loadChunk).toHaveBeenCalledTimes(1));
    expect(loadChunk).toHaveBeenCalledWith("2027-02");
    expect(
      screen.queryByText("This event couldn't be found.")
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("August Hall").length).toBeGreaterThan(0);
    for (const link of screen.getAllByRole("link", { name: "August Hall" })) {
      expect(link).toHaveAttribute("href", "https://www.augusthallsf.com/");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link.querySelector("svg")).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: "Venue website" })).toBeNull();
  });
});

describe("show list rows and hero poster flow", () => {
  const poster: Event["poster"] = {
    imageUrl: "https://chapel.example/devil-makes-three.jpg",
    eventUrl: "https://chapel.example/show",
    kind: "poster",
    checkedOn: "2026-10-10",
  };
  const currentEvent = {
    id: 11,
    slug: "2026-10-20-the-devil-makes-three-the-chapel",
    date: "2026-10-20",
    dateEpochMs: Date.parse("2026-10-20T12:00:00Z"),
    headlinerName: "The Devil Makes Three",
    headlinerArtistId: 1,
    artistIds: [1],
    venueId: 2,
    status: "confirmed",
    createdAtEpochMs: Date.parse("2026-05-08T12:00:00Z"),
  } as unknown as Event;
  const siblingEvent = {
    ...currentEvent,
    id: 12,
    slug: "2026-10-13-militarie-gun-the-chapel",
    date: "2026-10-13",
    dateEpochMs: Date.parse("2026-10-13T12:00:00Z"),
    headlinerName: "Militarie Gun",
  } as unknown as Event;
  const venue = {
    id: 2,
    name: "Chapel",
    slug: "chapel",
    city: "San Francisco",
    website: "https://www.thechapelsf.com/",
    upcomingEvents: [siblingEvent, currentEvent],
  } as unknown as Venue;

  const boot = () =>
    useAppStore.setState({
      ...initial,
      events: new Map([
        [currentEvent.id, currentEvent],
        [siblingEvent.id, siblingEvent],
      ]),
      artists: new Map([
        [
          1 as Artist["id"],
          {
            id: 1,
            name: "The Devil Makes Three",
            slug: "the-devil-makes-three",
            upcomingEvents: [],
          } as Artist,
        ],
      ]),
      venues: new Map([[2 as Venue["id"], venue]]),
      loading: {
        ...initial.loading,
        artists: "success",
        venues: "success",
        indexes: "success",
        events: "success",
      },
    });

  it("reserves artwork slots, stacks price under the date and wraps names", () => {
    boot();
    render(
      <MemoryRouter
        initialEntries={["/events/2026-10-20-the-devil-makes-three-the-chapel"]}
      >
        <Routes>
          <Route path="/events/:slug" element={<EventDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    // Both rows show a reserved 36px-by-44px artwork slot even without posters.
    expect(screen.queryAllByLabelText(/official show page/)).toHaveLength(0);
    const frames = document.querySelectorAll("[aria-hidden='true'].h-11.w-9");
    expect(frames).toHaveLength(2);
    const militarie = screen.getByRole("link", {
      name: /Oct 13 Militarie Gun/,
    });
    expect(militarie.querySelector(".line-clamp-2")).toBeInTheDocument();
    expect(militarie.querySelector(".truncate")).toBeNull();
  });

  it("shows the official show artwork under the hero with artist cards on the left", () => {
    boot();
    useAppStore.setState({
      events: new Map([
        [currentEvent.id, { ...currentEvent, poster: poster! }] as [
          Event["id"],
          Event,
        ],
        [siblingEvent.id, siblingEvent],
      ]),
    });
    render(
      <MemoryRouter
        initialEntries={["/events/2026-10-20-the-devil-makes-three-the-chapel"]}
      >
        <Routes>
          <Route path="/events/:slug" element={<EventDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    const artLink = screen.getAllByRole("link", {
      name: /View The Devil Makes Three poster on the official show page/,
    });
    expect(artLink.length).toBeGreaterThan(0);
    const art = artLink[0]!;
    expect(art).toHaveAttribute("href", "https://chapel.example/show");
    expect(art).toHaveAttribute("target", "_blank");
  });
});
