import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalizeRickshawTicketUrl,
  classifyRickshawListing,
  fetchRickshawStop,
  parseRickshawCalendar,
  parseRickshawCalendarMonths,
  parseRickshawAjaxSettings,
  parseRickshawListPage,
  parseRickshawPagination,
  parseRickshawTicketUrl,
  rickshawPaginationRequestUrl,
} from "../../lib/ingestion/venues/rickshaw.js";
import type {
  FetchedText,
  VenueFetchContext,
  VenueSource,
} from "../../lib/ingestion/venue-types.js";

const fixtureRoot = new URL("../fixtures/venues/rickshaw/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, fixtureRoot), "utf8");
}

const source: VenueSource = {
  sourceId: "rickshaw-stop-sf",
  venueId: 31041890,
  venueName: "Rickshaw Stop",
  website: "https://rickshawstop.com/",
  calendarUrl: "https://rickshawstop.com/calendar/",
  timezone: "America/Los_Angeles",
  ticketHosts: ["wl.seetickets.us", "wl.eventim.us", "www.ticketmaster.com"],
  enabled: false,
};

function response(url: string, text: string, status = 200): FetchedText {
  return {
    url,
    text,
    status,
    fromCache: false,
    contentHash: `${status}-${text.length}`,
  };
}

function context(
  missingPages: number[] = [],
  emptyPages: number[] = []
): { context: VenueFetchContext; calls: string[] } {
  const calls: string[] = [];
  const pages = new Map<number, string>([
    [2, fixture("list-page-2.html")],
    [3, fixture("list-page-3.html")],
    [4, fixture("list-page-4.html")],
    [5, fixture("list-page-5.html")],
    [6, fixture("list-page-6.html")],
    [7, fixture("list-page-7.html")],
  ]);
  const fetchText = async (url: string): Promise<FetchedText> => {
    calls.push(url);
    if (url === source.calendarUrl)
      return response(url, fixture("calendar.html"));
    const match = url.match(/\/calendar\/list\/(\d+)$/u);
    const page = match ? Number(match[1]) : 0;
    if (missingPages.includes(page))
      throw new Error(`fixture page ${page} missing`);
    if (emptyPages.includes(page)) return response(url, "");
    const body = pages.get(page);
    if (!body) return response(url, "", 404);
    return response(url, body);
  };
  return {
    context: {
      source,
      nowEpochMs: Date.parse("2026-09-08T12:00:00Z"),
      fetchText,
    },
    calls,
  };
}

describe("Rickshaw pure parsers", () => {
  it("retains all month headings and continues past empty months", () => {
    const html = fixture("calendar.html");
    expect(parseRickshawCalendarMonths(html)).toHaveLength(12);
    expect(parseRickshawCalendar(html)).toHaveLength(8);
    expect(parseRickshawCalendarMonths(html)).toEqual(
      expect.arrayContaining(["January 2027", "March 2027", "August 2027"])
    );
    expect(parseRickshawCalendar(html).map((record) => record.date)).toEqual(
      expect.arrayContaining(["2027-02-19"])
    );
  });

  it("reads page controls without synthesizing private AJAX endpoints", () => {
    const pagination = parseRickshawPagination(fixture("calendar.html"));
    expect(pagination.pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pagination.links.find((link) => link.page === 2)?.url).toBe(
      "https://rickshawstop.com/calendar/list/2"
    );
    const dataOnly =
      '<script>var seetickets_ajax_obj = {"ajax_url":"https://rickshawstop.com/wp-admin/admin-ajax.php","nonce":"fixture-nonce"};</script>' +
      fixture("calendar.html").replace(
        /<a href="\/calendar\/list\/\d+">(\d+)<\/a>/gu,
        "<span>$1</span>"
      );
    expect(
      parseRickshawPagination(dataOnly).links.some((link) => link.url)
    ).toBe(false);
    const settings = parseRickshawAjaxSettings(dataOnly);
    expect(settings).toMatchObject({
      ajaxUrl: "https://rickshawstop.com/wp-admin/admin-ajax.php",
      nonce: "fixture-nonce",
      listType: "list",
      currentList: "1",
    });
    expect(rickshawPaginationRequestUrl(settings!, 2)).toBe(
      "https://rickshawstop.com/wp-admin/admin-ajax.php?action=get_seetickets_events&nonce=fixture-nonce&listType=list&seeAjaxPage=2&currentList=1"
    );
  });

  it("decodes only recognized URL Defense destinations and canonicalizes tracking", () => {
    const wrapped =
      "https://urldefense.com/v3/__https://www.ticketmaster.com/event/ABC123?camefrom=CFC__;TOKEN";
    expect(canonicalizeRickshawTicketUrl(wrapped)).toBe(
      "https://www.ticketmaster.com/event/ABC123"
    );
    expect(parseRickshawTicketUrl(wrapped)).toMatchObject({
      provider: "ticketmaster",
      eventId: "ABC123",
      trusted: true,
    });
    const sourceCapture =
      "https://urldefense.com/v3/__https://www.ticketmaster.com/event/1C0064B4F434F589?camefrom=CFC_ANOTHERPLANET_artist&brand=anotherplanet__;TOKEN";
    expect(parseRickshawTicketUrl(sourceCapture)).toMatchObject({
      provider: "ticketmaster",
      eventId: "1C0064B4F434F589",
      trusted: true,
    });
    const encoded =
      "https://urldefense.com/v3/__https%3A%2F%2Fwww.ticketmaster.com%2Fevent%2FABC123%3Fbrand%3Danotherplanet__;TOKEN";
    expect(canonicalizeRickshawTicketUrl(encoded)).toBe(
      "https://www.ticketmaster.com/event/ABC123"
    );
    expect(
      canonicalizeRickshawTicketUrl("https://example.com/event/42")
    ).toBeNull();
    expect(
      parseRickshawTicketUrl(
        "https://www.axs.com/events/1576454/jt-tickets?skin=goldenvoice",
        source.calendarUrl,
        source.ticketHosts
      )
    ).toMatchObject({
      provider: "axs",
      eventId: "1576454",
      canonicalUrl: "https://www.axs.com/events/1576454/jt-tickets",
      trusted: true,
    });
  });

  it("keeps a band's record release party as live music", () => {
    const [record] = parseRickshawListPage(
      '<div class="seetickets-list-event-container"><p class="title"><a href="https://wl.seetickets.us/event/country-risque/702103">Country Risqué (record release party)</a></p><p class="headliners">Country Risqué</p><p class="genre">Country</p></div>'
    );
    expect(classifyRickshawListing(undefined, record).kind).toBe("live");
  });

  it("does not infer sold-out from More Info without the sold-out class", () => {
    const normalInfo = fixture("list-page-4.html").replace(
      "button-soldout",
      "button-gettickets"
    );
    expect(parseRickshawListPage(normalInfo)[0].status).toBe("confirmed");
  });
});

describe("fetchRickshawStop", () => {
  it("deduplicates calendar and list presentations while preserving the calendar key", async () => {
    const { context: fetchContext } = context();
    const result = await fetchRickshawStop(fetchContext);
    const alpha = result.listings.filter(
      (listing) => listing.title === "ALPHA" && listing.date === "2026-09-08"
    );
    expect(alpha).toHaveLength(1);
    expect(result.inventories[0].keys).toContain(alpha[0].key);
    expect(result.inventories[0].complete).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("follows the source-exposed public AJAX flow when controls have no href", async () => {
    const ajaxCalendar =
      '<script>var seetickets_ajax_obj = {"ajax_url":"https://rickshawstop.com/wp-admin/admin-ajax.php","nonce":"fixture-nonce"};</script>' +
      fixture("calendar.html").replace(
        /<a href="\/calendar\/list\/\d+">(\d+)<\/a>/gu,
        "<span>$1</span>"
      );
    const pages = new Map<number, string>([
      [2, fixture("list-page-2.html")],
      [3, fixture("list-page-3.html")],
      [4, fixture("list-page-4.html")],
      [5, fixture("list-page-5.html")],
      [6, fixture("list-page-6.html")],
      [7, fixture("list-page-7.html")],
    ]);
    const calls: string[] = [];
    const fetchText = async (url: string): Promise<FetchedText> => {
      calls.push(url);
      if (url === source.calendarUrl) return response(url, ajaxCalendar);
      const page = Number(new URL(url).searchParams.get("seeAjaxPage"));
      const body = pages.get(page);
      return response(url, body ?? "", body ? 200 : 404);
    };
    const result = await fetchRickshawStop({
      source,
      nowEpochMs: Date.parse("2026-09-08T12:00:00Z"),
      fetchText,
    });
    expect(result.complete).toBe(true);
    expect(calls).toHaveLength(7);
    expect(
      calls
        .slice(1)
        .every((url) =>
          url.includes("/wp-admin/admin-ajax.php?action=get_seetickets_events")
        )
    ).toBe(true);
  });

  it("keeps calendar discoveries and marks detail coverage partial after a page gap", async () => {
    const { context: fetchContext, calls } = context([4]);
    const result = await fetchRickshawStop(fetchContext);
    expect(result.complete).toBe(false);
    expect(result.inventories[0].complete).toBe(true);
    expect(result.inventories[0].keys.length).toBe(8);
    expect(result.inventories[1].complete).toBe(false);
    expect(result.listings.some((listing) => listing.title === "SOLYA")).toBe(
      true
    );
    expect(calls).toHaveLength(7);
    expect(result.warnings.join(" ")).toMatch(/page 4 fetch failed/u);
  });

  it("preserves sold-out status when the source button says More Info", async () => {
    const { context: fetchContext } = context();
    const result = await fetchRickshawStop(fetchContext);
    const solya = result.listings.find((listing) => listing.title === "SOLYA");
    expect(solya).toMatchObject({
      status: "sold-out",
      priceMin: 22,
      priceMax: 67,
    });
    expect(solya?.notes).toMatch(/button-soldout.*More Info/u);
  });

  it("keeps themed dance records for review without making theme names artists", async () => {
    const { context: fetchContext } = context();
    const result = await fetchRickshawStop(fetchContext);
    const dance = result.listings.find((listing) =>
      listing.title.startsWith("DANCE")
    );
    expect(dance).toMatchObject({ kind: "review", artists: [] });
    expect(dance?.reason).toMatch(/dance|themed/iu);
  });

  it("keeps same-ticket multi-session performances separate", async () => {
    const { context: fetchContext } = context();
    const result = await fetchRickshawStop(fetchContext);
    const sessions = result.listings
      .filter((listing) => listing.title === "TWO SESSIONS")
      .sort((a, b) => (a.session ?? "").localeCompare(b.session ?? ""));
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((listing) => listing.key)).size).toBe(2);
    expect(sessions.map((listing) => listing.session)).toEqual([
      "19:00",
      "21:00",
    ]);
  });

  it("reports truncated list enrichment without dropping calendar records", async () => {
    const { context: fetchContext } = context([], [7]);
    const result = await fetchRickshawStop(fetchContext);
    expect(result.complete).toBe(false);
    expect(result.inventories[0].keys).toHaveLength(8);
    expect(result.inventories[1].complete).toBe(false);
    expect(
      result.listings.filter((listing) => listing.date !== "unknown")
    ).toHaveLength(8);
  });

  it("starts coverage at the current local source date", async () => {
    const { context: fetchContext } = context();
    fetchContext.nowEpochMs = Date.parse("2026-09-01T12:00:00Z");
    const result = await fetchRickshawStop(fetchContext);
    expect(result.coverageStart).toBe("2026-09-01");
  });
});
