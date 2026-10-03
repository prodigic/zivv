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
    await screen.findByRole("heading", { name: "Death From Above 1979" });
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
