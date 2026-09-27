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
import { MemoryRouter } from "react-router-dom";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import type { Artist, Event, Venue } from "@/types/events.ts";
import type { DataManifest } from "@/types/data.ts";

vi.mock("@/components/layout/AppShell.tsx", () => ({
  ContentArea: ({
    children,
    title,
    subtitle,
  }: {
    children: React.ReactNode;
    title?: string;
    subtitle?: string;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </main>
  ),
}));

import HomePage from "@/pages/HomePage.tsx";

const initialState = useAppStore.getState();
const now = Date.parse("2026-09-27T19:00:00Z");
const months = [
  "2026-01",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
  "2027-05",
];
const fixture = (id: number, date: string, recent = false) =>
  ({
    id,
    slug: `show-${id}`,
    date,
    dateEpochMs: Date.parse(`${date}T19:00:00Z`),
    headlinerArtistId: id,
    artistIds: [id],
    venueId: 1,
    isFree: false,
    tags: [],
    status: "confirmed",
    timezone: "America/Los_Angeles",
    createdAtEpochMs: recent ? now - 86400000 : now - 30 * 86400000,
    addedDateProvenance: "observed",
    timeBasis: "instant",
  }) as Event;
const past = fixture(1, "2026-08-15");
const upcoming = fixture(2, "2026-09-28", true);
const future = fixture(3, "2027-05-01");
const loadChunk = vi.fn(async (id: string) => {
  const rows =
    id === "2026-08"
      ? [past]
      : id === "2026-09"
        ? [upcoming]
        : id === "2027-05"
          ? [future]
          : [];
  useAppStore.setState((state) => ({
    events: new Map([...state.events, ...rows.map((e) => [e.id, e] as const)]),
    loadedChunks: new Set([...state.loadedChunks, id]),
    loading: { ...state.loading, events: "success" },
    errors: { ...state.errors, events: null },
  }));
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  loadChunk.mockClear();
  useFilterStore.getState().clearFilters();
  useAppStore.setState({
    ...initialState,
    initialize: vi.fn().mockResolvedValue(undefined),
    manifest: {
      datasetVersion: "cold-start-test",
      chunks: { events: months.map((chunkId) => ({ chunkId })) },
    } as DataManifest,
    artists: new Map(
      [1, 2, 3].map((id) => [
        id,
        {
          id,
          name: ["", "Past Band", "Upcoming Band", "Future Band"][id],
        } as Artist,
      ])
    ) as Map<Artist["id"], Artist>,
    venues: new Map([
      [1, { id: 1, name: "Test Venue", city: "San Francisco" } as Venue],
    ]) as Map<Venue["id"], Venue>,
    events: new Map(),
    loadedChunks: new Set(),
    showUpcomingOnly: true,
    loading: {
      ...initialState.loading,
      artists: "success",
      manifest: "success",
      venues: "success",
      events: "idle",
    },
    errors: { ...initialState.errors, events: null },
    loadChunk,
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState(initialState);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const openHome = () =>
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );

describe("Homepage monthly event loading", () => {
  it("applies venue filters to the loaded upcoming months", async () => {
    useFilterStore.getState().setFilters({ venues: ["Test Venue"] });
    openHome();
    expect(await screen.findByText("Upcoming Band")).toBeInTheDocument();
    expect(await screen.findByText("Future Band")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
  });

  it("loads upcoming shows on a cold visit when the first six chunks are historical", async () => {
    openHome();
    expect(await screen.findByText("Upcoming Band")).toBeInTheDocument();
    expect(await screen.findByText("Future Band")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
    expect(screen.queryByText("Past Band")).not.toBeInTheDocument();
    expect(loadChunk.mock.calls.map(([id]) => id).sort()).toEqual([
      "2026-09",
      "2027-05",
    ]);
    expect(screen.getAllByRole("img", { name: "Recently added" })).toHaveLength(
      1
    );
    expect(
      screen.getByRole("img", { name: "Recently added" })
    ).toHaveTextContent("🆕");
  });

  it("loads missing upcoming months even if another route already loaded past events", async () => {
    useAppStore.setState((state) => ({
      events: new Map([[past.id, past]]),
      loading: { ...state.loading, events: "success" },
    }));
    openHome();
    expect(await screen.findByText("Upcoming Band")).toBeInTheDocument();
    expect(await screen.findByText("Future Band")).toBeInTheDocument();
  });

  it("loads historical months when the upcoming-only filter is disabled", async () => {
    useAppStore.setState({ showUpcomingOnly: false });
    openHome();
    expect(await screen.findByText("Past Band")).toBeInTheDocument();
    expect(await screen.findByText("Future Band")).toBeInTheDocument();
    expect(loadChunk.mock.calls.map(([id]) => id).sort()).toEqual(
      [...months].sort()
    );
  });

  it("shows a failed month and retries it even when another month's request succeeds", async () => {
    loadChunk.mockRejectedValueOnce(new Error("September download failed"));
    openHome();
    expect(
      await screen.findByText("September download failed")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No events match your filters.")
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await waitFor(() =>
      expect(screen.getByText("Upcoming Band")).toBeInTheDocument()
    );
    expect(
      screen.queryByText("September download failed")
    ).not.toBeInTheDocument();
    expect(
      loadChunk.mock.calls.every(([id]) => id === "2026-09" || id === "2027-05")
    ).toBe(true);
  });
});
