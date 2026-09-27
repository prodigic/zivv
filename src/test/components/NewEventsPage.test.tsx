/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mock = vi.hoisted(() => {
  const nowMs = Date.parse("2026-09-12T12:00:00-07:00");
  const createdAtEpochMs = Date.parse("2026-09-10T12:00:00-07:00");
  const showEpochMs = Date.parse("2026-09-14T20:00:00-07:00");
  const event = {
    id: 101,
    slug: "test-band-2026-09-14",
    date: "2026-09-14",
    dateEpochMs: showEpochMs,
    startTime: "2026-09-14T20:00:00-07:00",
    startTimeEpochMs: showEpochMs,
    timeBasis: "instant",
    timezone: "America/Los_Angeles",
    headlinerArtistId: 1,
    artistIds: [1],
    venueId: 2,
    isFree: false,
    ageRestriction: "all-ages",
    status: "confirmed",
    tags: [],
    venueType: "club",
    createdAtEpochMs,
    updatedAtEpochMs: createdAtEpochMs,
    sourceLineNumber: 1,
    firstImportedBy: "zivv-venue-import",
    addedDateProvenance: "observed",
    sources: [{ kind: "venue-calendar", sourceId: "venue-2" }],
  };
  const store = {
    events: new Map([[101, event]]),
    artists: new Map([
      [
        1,
        {
          id: 1,
          name: "Test Band",
          slug: "test-band",
        },
      ],
    ]),
    venues: new Map([
      [
        2,
        {
          id: 2,
          name: "Test Venue",
          city: "San Francisco",
        },
      ],
    ]),
    manifest: {
      datasetVersion: "test-dataset",
      chunks: {
        events: [{ chunkId: "2026-09" }],
        recentAdditions: { filename: "recent-additions.json" },
      },
    },
    loadedChunks: new Set(["2026-09"]),
    recentAdditions: {
      schemaVersion: 1,
      datasetVersion: "test-dataset",
      events: [
        {
          eventId: 101,
          chunkId: "2026-09",
          createdAtEpochMs,
          addedDateProvenance: "observed",
          firstImportedBy: "zivv-venue-import",
          sourceKinds: ["venue-calendar"],
        },
      ],
    },
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
    initialize: vi.fn().mockResolvedValue(undefined),
    loadChunk: vi.fn().mockResolvedValue(undefined),
    loadRecentAdditions: vi.fn().mockResolvedValue(undefined),
  };
  const useAppStore = Object.assign(
    (selector?: (value: typeof store) => unknown) =>
      selector ? selector(store) : store,
    { getState: () => store }
  );
  return { nowMs, store, useAppStore };
});

vi.mock("@/stores/appStore.js", () => ({
  useAppStore: mock.useAppStore,
}));

import NewEventsPage from "@/pages/NewEventsPage.js";

describe("NewEventsPage discovery controls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mock.nowMs);
    mock.store.loading.events = "success";
    mock.store.errors.events = null;
    mock.store.loadedChunks = new Set(["2026-09"]);
    mock.store.loadChunk.mockClear();
    mock.store.loadRecentAdditions.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a blank custom range invalid and applies both source filters", () => {
    render(
      <MemoryRouter initialEntries={["/new"]}>
        <NewEventsPage />
      </MemoryRouter>
    );

    expect(screen.getByText("Test Band")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(
      screen.getByText("Choose a valid inclusive date range.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Test Band")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.change(screen.getByLabelText("Through"), {
      target: { value: "2026-09-10" },
    });
    expect(screen.getByText("Test Band")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Recently added" })
    ).toHaveTextContent("🆕");
    expect(screen.getByRole("img", { name: "Recently added" })).toHaveAttribute(
      "title",
      "Added Sep 10"
    );
    expect(screen.queryByText("Added Sep 10")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("First imported by"), {
      target: { value: "zivv-venue-import" },
    });
    fireEvent.change(screen.getByLabelText("Listed by"), {
      target: { value: "venue-calendar" },
    });
    expect(screen.getByText("Test Band")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("First imported by"), {
      target: { value: "steveslist" },
    });
    expect(
      screen.getByText("No upcoming events were added in this window.")
    ).toBeInTheDocument();
  });
});
