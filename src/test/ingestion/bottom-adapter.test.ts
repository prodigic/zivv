import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOTTOM_CALENDAR_URL,
  BOTTOM_RSS_URL,
  fetchBottomOfTheHill,
  parseBottomCalendar,
  parseBottomRss,
} from "../../lib/ingestion/venues/bottom.js";
import type {
  FetchedText,
  VenueFetchContext,
  VenueSource,
} from "../../lib/ingestion/venue-types.js";

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../fixtures/venues/bottom/${name}`, import.meta.url),
    "utf8"
  );

const calendar = fixture("calendar.html");
const rss = fixture("rss.xml");

const source: VenueSource = {
  sourceId: "bottom-of-the-hill-sf",
  venueId: 1016385760,
  venueName: "Bottom of the Hill",
  website: "https://www.bottomofthehill.com/",
  calendarUrl: BOTTOM_CALENDAR_URL,
  feedUrls: [BOTTOM_RSS_URL],
  timezone: "America/Los_Angeles",
  ticketHosts: ["www.bottomofthehill.com"],
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
  fetchText: VenueFetchContext["fetchText"]
): VenueFetchContext {
  return {
    source,
    nowEpochMs: Date.parse("2026-09-07T12:00:00-07:00"),
    fetchText,
  };
}

describe("Bottom of the Hill calendar parser", () => {
  it("keeps ordered performers, dates, sessions, status, and price concepts", () => {
    const parsed = parseBottomCalendar(calendar, {
      baseUrl: BOTTOM_CALENDAR_URL,
    });
    expect(parsed.complete).toBe(true);
    expect(parsed.listings).toHaveLength(5);
    expect(parsed.listings[0]).toMatchObject({
      date: "2026-09-11",
      artists: ["Bratmobile", "The Okmonics"],
      status: "sold-out",
      priceMin: 35,
      priceMax: 35,
      ticketUrl: "https://www.bottomofthehill.com/stubmatic/event20260911.html",
    });
    expect(parsed.listings[0]?.notes).toContain("6.81 service fee");
    expect(parsed.listings[2]).toMatchObject({
      date: "2026-10-08",
      artists: ["Casa Sueño", "Ray Yeh"],
      session: "2:00PM to 5:00PM",
    });
    expect(parsed.listings[3]).toMatchObject({
      kind: "non-music",
      reason: expect.stringContaining("non-band"),
    });
    expect(parsed.listings[4]).toMatchObject({ kind: "package" });
  });

  it("fails closed for empty and truncated markup", () => {
    expect(parseBottomCalendar("").complete).toBe(false);
    expect(
      parseBottomCalendar(
        '<table id="listings"><tr><td><a href="/20260911.html">show</a>'
      ).complete
    ).toBe(false);
  });
});

describe("Bottom of the Hill RSS parser", () => {
  it("deduplicates revisions by canonical URL and retains the newest lineup", () => {
    const parsed = parseBottomRss(rss, { baseUrl: BOTTOM_RSS_URL });
    expect(parsed.complete).toBe(true);
    expect(parsed.revisions).toHaveLength(2);
    expect(
      parsed.revisions.find((revision) => revision.date === "2026-10-06")
    ).toMatchObject({
      guid: "new-oct-six",
      artists: ["zzzahara", "Faerybabyy", "fime"],
    });
  });

  it("fails closed for an empty or truncated feed", () => {
    expect(parseBottomRss("").complete).toBe(false);
    expect(parseBottomRss(rss.replace("</rss>", "")).complete).toBe(false);
  });
});

describe("Bottom of the Hill adapter", () => {
  it("keeps a calendar-only show and reports the RSS gap", async () => {
    const requested: string[] = [];
    const result = await fetchBottomOfTheHill(
      contextFor(async (url) => {
        requested.push(url);
        return url.endsWith("RSS.xml")
          ? response(url, rss)
          : response(url, calendar);
      })
    );

    expect(requested).toEqual([BOTTOM_CALENDAR_URL, BOTTOM_RSS_URL]);
    expect(result.complete).toBe(true);
    expect(result.listings).toHaveLength(5);
    expect(
      result.listings.find((listing) => listing.url.endsWith("20261006.html"))
    ).toMatchObject({
      artists: ["zzzahara", "Faerybabyy", "fime"],
      evidence: expect.stringContaining("new-oct-six"),
    });
    expect(
      result.listings.find((listing) => listing.url.endsWith("20261008.html"))
    ).toMatchObject({
      artists: ["Casa Sueño", "Ray Yeh"],
    });
    expect(result.inventories[0]).toMatchObject({
      name: "discovered-calendar",
      complete: true,
      keys: expect.arrayContaining([
        "https://www.bottomofthehill.com/20261008.html",
      ]),
    });
    expect(result.coverageStart).toBe("2026-09-07");
    expect(result.warnings.join(" ")).toContain("RSS feed gap");
    expect(result.warnings.join(" ")).toContain("20261008");
  });

  it("does not claim complete when either source retrieval fails", async () => {
    const result = await fetchBottomOfTheHill(
      contextFor(async (url) => {
        if (url.endsWith("RSS.xml")) throw new Error("fixture feed failed");
        return response(url, calendar);
      })
    );
    expect(result.complete).toBe(false);
    expect(result.listings).toHaveLength(5);
    expect(result.warnings.join(" ")).toContain("RSS fetch failed");
  });

  it("marks a current RSS-only URL for review without inventing a calendar listing", async () => {
    const rssOnly = rss.replace(
      "</channel>",
      `
        <item>
          <title>2026 11/01 : RSS Only Test</title>
          <description><![CDATA[<b>RSS Only Test</b><br />7:00PM doors -- music 8PM<br />$12<br />(all ages)]]></description>
          <link>https://www.bottomofthehill.com/20261101.html</link>
          <guid>rss-only-test</guid>
          <pubDate>Tue, 08 Sep 2026 10:00:00 -0700</pubDate>
        </item>
      </channel>`
    );
    const result = await fetchBottomOfTheHill(
      contextFor(async (url) =>
        url.endsWith("RSS.xml")
          ? response(url, rssOnly)
          : response(url, calendar)
      )
    );

    expect(result.complete).toBe(false);
    expect(
      result.listings.some((listing) => listing.url.endsWith("20261101.html"))
    ).toBe(false);
    expect(result.inventories[1]).toMatchObject({
      name: "rss-revisions",
      complete: false,
      keys: expect.arrayContaining([
        "https://www.bottomofthehill.com/20261101.html",
      ]),
    });
    expect(result.warnings.join(" ")).toContain(
      "outside the calendar baseline"
    );
  });
});
