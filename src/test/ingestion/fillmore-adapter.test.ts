import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditOfficialFillmoreHtml,
  fetchFillmore,
  FILLMORE_CALENDAR_URL,
  FILLMORE_TICKETMASTER_VENUE_ID,
  parseTicketmasterEvent,
} from "../../lib/ingestion/venues/fillmore.js";
import type {
  FetchedText,
  VenueFetchContext,
  VenueSource,
} from "../../lib/ingestion/venue-types.js";

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../fixtures/venues/fillmore/${name}`, import.meta.url),
    "utf8"
  );

const initialHtml = fixture("initial.html");
const initialSubsetHtml = fixture("initial-subset.html");
const pageZero = fixture("discovery-page-0.json");
const pageOne = fixture("discovery-page-1.json");
const apiKey = "fixture-secret-key";

const source: VenueSource = {
  sourceId: "fillmore-sf",
  venueId: 1136597428,
  venueName: "Fillmore",
  website: "https://www.thefillmore.com/",
  calendarUrl: FILLMORE_CALENDAR_URL,
  timezone: "America/Los_Angeles",
  providerVenueIds: { ticketmasterDiscovery: FILLMORE_TICKETMASTER_VENUE_ID },
  ticketHosts: ["www.ticketmaster.com"],
  enabled: false,
};

function response(url: string, text: string): FetchedText {
  return {
    url,
    text,
    status: 200,
    fromCache: false,
    contentHash: "fixture-hash",
  };
}

function contextFor(
  fetchText: VenueFetchContext["fetchText"],
  key: string | undefined = apiKey
): VenueFetchContext {
  return {
    source,
    nowEpochMs: Date.parse("2026-09-08T12:00:00Z"),
    fetchText,
    ticketmasterApiKey: key,
  };
}

describe("Fillmore official HTML audit", () => {
  it("keeps initial JSON-LD partial and reviews missing performer markup", () => {
    const audit = auditOfficialFillmoreHtml(
      initialHtml,
      FILLMORE_CALENDAR_URL,
      source
    );

    expect(audit.initialJsonLdCount).toBe(3);
    expect(audit.complete).toBe(false);
    expect(audit.venueMatched).toBe(true);
    expect(audit.listings).toHaveLength(3);
    expect(audit.listings[0]).toMatchObject({
      kind: "live",
      artists: ["Fixture Headliner"],
    });
    expect(audit.listings[1]).toMatchObject({
      kind: "package",
      artists: ["Fixture Band"],
      session: "2026-10-03/2026-10-05",
    });
    expect(audit.listings[2]).toMatchObject({
      kind: "review",
      artists: [],
      reason: expect.stringContaining("missing explicit performer markup"),
    });
    expect(audit.warnings.join(" ")).toContain("initial JSON-LD only");
  });
});

describe("Fillmore Ticketmaster Discovery adapter", () => {
  it("uses verified venue pagination and retains packages without expanding performances", async () => {
    const requested: string[] = [];
    const context = contextFor(async (url) => {
      requested.push(url);
      const parsed = new URL(url);
      if (parsed.hostname === "app.ticketmaster.com") {
        return response(
          url,
          parsed.searchParams.get("page") === "1" ? pageOne : pageZero
        );
      }
      return response(url, initialHtml);
    });

    const result = await fetchFillmore(context);
    const apiRequests = requested.filter(
      (url) => new URL(url).hostname === "app.ticketmaster.com"
    );
    const firstApiUrl = new URL(apiRequests[0]);

    expect(result.complete).toBe(true);
    expect(result.listings).toHaveLength(3);
    expect(
      result.listings.find((listing) => listing.key === "FILL002")
    ).toMatchObject({
      kind: "package",
      session: "2026-10-03/2026-10-05",
    });
    expect(result.inventories[0]).toMatchObject({
      name: "primary-discovery",
      complete: true,
      requiredForCoverage: true,
      keys: ["FILL001", "FILL002", "FILL003"],
    });
    expect(result.inventories[2]).toMatchObject({
      name: "official-html-jsonld-audit",
      complete: false,
      requiredForCoverage: false,
    });
    expect(apiRequests).toHaveLength(2);
    expect(firstApiUrl.searchParams.get("venueId")).toBe(
      FILLMORE_TICKETMASTER_VENUE_ID
    );
    expect(firstApiUrl.searchParams.get("page")).toBe("0");
    expect(firstApiUrl.searchParams.get("size")).toBe("200");
    expect(firstApiUrl.searchParams.get("startDateTime")).toBe(
      "2026-09-08T07:00:00.000Z"
    );
    expect(firstApiUrl.searchParams.get("apikey")).toBe(apiKey);
    expect(result.warnings.join(" ")).not.toContain(apiKey);
  });

  it("keeps an API-complete result complete when the initial HTML audit is a subset", async () => {
    const context = contextFor(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === "app.ticketmaster.com") {
        return response(
          url,
          parsed.searchParams.get("page") === "1" ? pageOne : pageZero
        );
      }
      return response(url, initialSubsetHtml);
    });

    const result = await fetchFillmore(context);
    expect(result.complete).toBe(true);
    expect(result.inventories[0]?.keys).toEqual([
      "FILL001",
      "FILL002",
      "FILL003",
    ]);
    expect(result.inventories[2]).toMatchObject({
      complete: false,
      requiredForCoverage: false,
      keys: ["FILL001"],
    });
  });

  it("surfaces missing page metadata and stops after the bounded first request", async () => {
    const requested: string[] = [];
    const incompletePage = JSON.stringify({
      _embedded: { events: [] },
      page: { number: 0 },
    });
    const context = contextFor(async (url) => {
      requested.push(url);
      return url.includes("app.ticketmaster.com")
        ? response(url, incompletePage)
        : response(url, initialHtml);
    });

    const result = await fetchFillmore(context);
    expect(result.complete).toBe(false);
    expect(
      requested.filter((url) => url.includes("app.ticketmaster.com"))
    ).toHaveLength(1);
    expect(result.warnings).toContain(
      "Ticketmaster Discovery API page metadata is incomplete"
    );
  });

  it("detects repeated page contents instead of retrying indefinitely", async () => {
    const requested: string[] = [];
    const repeatedPage = JSON.parse(pageZero) as { page: { number: number } };
    const context = contextFor(async (url) => {
      requested.push(url);
      if (!url.includes("app.ticketmaster.com"))
        return response(url, initialHtml);
      const page = new URL(url).searchParams.get("page");
      repeatedPage.page.number = page === "1" ? 1 : 0;
      return response(url, JSON.stringify(repeatedPage));
    });

    const result = await fetchFillmore(context);
    expect(result.complete).toBe(false);
    expect(
      requested.filter((url) => url.includes("app.ticketmaster.com"))
    ).toHaveLength(2);
    expect(result.warnings).toContain(
      "Ticketmaster Discovery API repeated page contents"
    );
  });

  it("uses the official page only as an explicitly incomplete no-key fallback", async () => {
    const requested: string[] = [];
    const context = contextFor(async (url) => {
      requested.push(url);
      return response(url, initialHtml);
    }, "");

    const result = await fetchFillmore(context);
    expect(result.complete).toBe(false);
    expect(requested).toEqual([FILLMORE_CALENDAR_URL]);
    expect(result.coverageStart).toBe("2026-09-08");
    expect(result.listings).toHaveLength(3);
    expect(
      result.listings.find((listing) => listing.key === "FILL003")
    ).toMatchObject({
      kind: "review",
      artists: [],
    });
    expect(result.warnings.join(" ")).toContain(
      "official HTML fallback is partial"
    );
  });

  it("rejects an API event whose embedded venue ID is not the verified Fillmore", () => {
    const event = {
      id: "WRONG-VENUE",
      name: "Wrong venue event",
      dates: { start: { localDate: "2026-09-12" } },
      _embedded: {
        venues: [{ id: "another-venue", name: "Another venue" }],
        attractions: [{ name: "Should not be imported" }],
      },
    };
    expect(parseTicketmasterEvent(event, source)).toBeNull();
  });

  it("keeps an individually dated residency performance as live", () => {
    const event = {
      id: "RESIDENCY-NIGHT",
      name: "Fixture Residency Night",
      url: "https://www.ticketmaster.com/fixture-residency/event/RESIDENCY-NIGHT",
      dates: {
        start: {
          localDate: "2026-11-14",
          dateTime: "2026-11-15T04:00:00Z",
        },
      },
      _embedded: {
        venues: [{ id: FILLMORE_TICKETMASTER_VENUE_ID, name: "The Fillmore" }],
        attractions: [{ name: "Fixture Resident" }],
      },
      classifications: [{ primary: true, segment: { name: "Music" } }],
    };
    expect(parseTicketmasterEvent(event, source)).toMatchObject({
      kind: "live",
      artists: ["Fixture Resident"],
    });
  });
});
