/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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
});
