/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mock = vi.hoisted(() => {
  const loadChunk = vi
    .fn()
    .mockRejectedValue(new Error("events-2026-09.json unavailable"));
  const store = {
    artists: new Map(),
    events: new Map(),
    venues: new Map(),
    manifest: {
      datasetVersion: "newsletter-test",
      chunks: { events: [{ chunkId: "2026-09" }] },
    },
    loadedChunks: new Set<string>(),
    loading: {
      manifest: "success",
      artists: "success",
      venues: "success",
      indexes: "success",
      events: "success",
      search: "success",
    },
    errors: {
      manifest: null,
      artists: null,
      venues: null,
      indexes: null,
      events: null,
      search: null,
    },
    localArtistExclude: new Set<string>(),
    localArtistList: new Set<string>(),
    initialize: vi.fn().mockResolvedValue(undefined),
    loadChunk,
  };
  const useAppStore = (selector?: (value: typeof store) => unknown) =>
    selector ? selector(store) : store;
  return { loadChunk, store, useAppStore };
});

vi.mock("@/stores/appStore.js", () => ({
  useAppStore: mock.useAppStore,
}));

import NewsletterPage from "@/pages/NewsletterPage.js";

describe("NewsletterPage chunk loading", () => {
  beforeEach(() => {
    mock.loadChunk
      .mockReset()
      .mockRejectedValue(new Error("events-2026-09.json unavailable"));
    mock.store.loadedChunks = new Set();
    mock.store.errors.events = null;
    mock.store.artists = new Map();
    mock.store.events = new Map();
    mock.store.venues = new Map();
    mock.store.localArtistList = new Set();
    mock.store.localArtistExclude = new Set();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("bolds a verified local support act without promoting a frequent touring headliner", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-27T18:00:00Z"));
    mock.store.loadedChunks = new Set(["2026-09"]);
    const shows = [1, 2, 3].map((id) => ({
      id,
      date: "2026-09-28",
      dateEpochMs: Date.parse("2026-09-29T03:00:00Z"),
      venueId: id === 3 ? 2 : 1,
      venueName: "Test Venue",
      venueCity: "San Francisco",
      artistIds: [10, 20],
      headlinerArtistId: 10,
      tags: [],
      status: "confirmed",
      createdAtEpochMs: 0,
    }));
    mock.store.artists = new Map([
      [10, { id: 10, name: "Touring Visitor", upcomingEvents: shows }],
      [20, { id: 20, name: "Verified Local", upcomingEvents: [shows[0]] }],
    ]);
    mock.store.events = new Map(shows.map((show) => [show.id, show]));
    mock.store.venues = new Map([
      [1, { name: "Test Venue", city: "San Francisco" }],
      [2, { name: "Other Venue", city: "San Francisco" }],
    ]);
    mock.store.localArtistList = new Set(["verified local"]);
    const { container } = render(
      <MemoryRouter>
        <NewsletterPage />
      </MemoryRouter>
    );
    const boldNames = [...container.querySelectorAll("article strong")].map(
      (node) => node.textContent
    );
    expect(boldNames).toContain("Verified Local");
    expect(boldNames.some((name) => name?.includes("Touring Visitor"))).toBe(
      false
    );
    expect(container.querySelector("article")?.textContent).toContain(
      "Touring Visitor"
    );
  });

  it("surfaces a failed required chunk without retrying or exposing copy", async () => {
    render(
      <MemoryRouter initialEntries={["/newsletter"]}>
        <NewsletterPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.getByText("events-2026-09.json unavailable")
      ).toBeInTheDocument();
    });
    expect(mock.loadChunk).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Copy for Reddit" })
    ).not.toBeInTheDocument();
  });

  it("splits every sfmusic section into SF then Nearby in preview and copied Markdown", async () => {
    const now = Date.parse("2026-09-27T18:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    mock.store.loadedChunks = new Set(["2026-09"]);
    const cities = [
      "San Francisco",
      "Oakland",
      "Berkeley",
      "Albany",
      "Emeryville",
      "Richmond",
      "S.F.",
      " oakland, CA ",
    ];
    const shows = cities.map((city, index) => ({
      id: index + 1,
      date: "2026-09-28",
      // Nearby starts earlier; SF still comes first in each section.
      dateEpochMs: Date.parse("2026-09-29T03:00:00Z") - index * 60000,
      venueId: index + 1,
      venueName: `Venue ${index + 1}`,
      venueCity: city,
      artistIds: [index + 1],
      headlinerArtistId: index + 1,
      tags: [],
      status: "confirmed",
      createdAtEpochMs: now - 3600000,
    }));
    mock.store.events = new Map(shows.map((show) => [show.id, show]));
    mock.store.venues = new Map(
      shows.map((show) => [
        show.venueId,
        { name: show.venueName, city: show.venueCity },
      ])
    );
    mock.store.artists = new Map(
      shows.map((show) => [
        show.id,
        { id: show.id, name: `Act ${show.id}`, upcomingEvents: [show] },
      ])
    );
    mock.store.localArtistList = new Set(shows.map((show) => `act ${show.id}`));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { container } = render(
      <MemoryRouter initialEntries={["/newsletter/sfmusic"]}>
        <Routes>
          <Route path="/newsletter/:city?" element={<NewsletterPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "sfmusic" })).toHaveAttribute(
      "href",
      "/newsletter/sfmusic"
    );
    expect(
      [...container.querySelectorAll("article h4")].map(
        (node) => node.textContent
      )
    ).toEqual(["SF", "Nearby", "SF", "Nearby", "SF", "Nearby"]);
    fireEvent.click(screen.getByRole("button", { name: "raw" }));
    const markdown = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
    const sections = markdown.split(/^### /m).slice(1);
    expect(sections).toHaveLength(3);
    for (const section of sections) {
      const [, sf, nearby] = section.split(/#### (?:SF|Nearby)\n/);
      for (const id of [1, 7]) {
        expect(sf).toContain(`Venue ${id}`);
        expect(nearby).not.toContain(`Venue ${id}`);
      }
      for (const id of [2, 3, 4, 8]) {
        expect(nearby).toContain(`Venue ${id}`);
        expect(sf).not.toContain(`Venue ${id}`);
      }
      expect(section).not.toMatch(/Venue [56]/);
    }
    fireEvent.click(screen.getByRole("button", { name: "Copy for Reddit" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));

    fireEvent.click(screen.getByRole("link", { name: "SF" }));
    expect(container.querySelectorAll("article h4")).toHaveLength(0);
    const sfMarkdown = (screen.getByRole("textbox") as HTMLTextAreaElement)
      .value;
    expect(sfMarkdown).toContain("Venue 1");
    expect(sfMarkdown).not.toMatch(/Venue [234568]/);
  });

  it("keeps both sfmusic subsections when no shows qualify", () => {
    mock.store.loadedChunks = new Set(["2026-09"]);
    render(
      <MemoryRouter initialEntries={["/newsletter/sfmusic"]}>
        <Routes>
          <Route path="/newsletter/:city" element={<NewsletterPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(
      screen.getAllByRole("heading", { level: 4, name: "SF" })
    ).toHaveLength(3);
    expect(
      screen.getAllByRole("heading", { level: 4, name: "Nearby" })
    ).toHaveLength(3);
    expect(screen.getAllByText("No additions this week.")).toHaveLength(2);
  });
});
