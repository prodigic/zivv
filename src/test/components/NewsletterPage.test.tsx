/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    mock.loadChunk.mockClear();
    mock.store.loadedChunks = new Set();
    mock.store.errors.events = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
