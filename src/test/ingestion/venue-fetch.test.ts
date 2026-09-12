import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createVenueFetcher } from "../../lib/ingestion/venue-fetch.js";
import type { VenueSource } from "../../lib/ingestion/venue-types.js";

const roots: string[] = [];
const source: VenueSource = {
  sourceId: "test",
  venueId: 1,
  venueName: "Test",
  website: "https://venue.example/",
  calendarUrl: "https://venue.example/calendar",
  timezone: "America/Los_Angeles",
  enabled: false,
};
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "zivv-fetch-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir(), "zivv-fetch-")))
      throw new Error("Unsafe cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});

describe("conditional venue fetching", () => {
  it("decodes declared encoding and reuses cached bytes only after a valid 304", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          new Uint8Array(
            Buffer.from('<meta charset="ISO-8859-1">Casa Sueño', "latin1")
          ),
          {
            headers: {
              etag: '"one"',
              "last-modified": "Mon, 07 Sep 2026 12:00:00 GMT",
            },
          }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const client = createVenueFetcher(root(), source, { fetch, delayMs: 0 });
    expect((await client.fetchText(source.calendarUrl)).text).toContain(
      "Sueño"
    );
    const second = await client.fetchText(source.calendarUrl);
    expect(second.fromCache).toBe(true);
    expect(client.observations[1]).toMatchObject({ status: 304, bytes: 0 });
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({
      "If-None-Match": '"one"',
      "If-Modified-Since": "Mon, 07 Sep 2026 12:00:00 GMT",
    });
  });

  it("preserves good cache on failure and refuses unapproved redirects and oversized bodies", async () => {
    const directory = root();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("good"))
      .mockResolvedValueOnce(new Response("blocked", { status: 403 }));
    const client = createVenueFetcher(directory, source, { fetch, delayMs: 0 });
    await client.fetchText(source.calendarUrl);
    await expect(client.fetchText(source.calendarUrl)).rejects.toThrow(
      "HTTP 403"
    );
    expect(
      (
        await createVenueFetcher(directory, source, {
          offline: true,
        }).fetchText(source.calendarUrl)
      ).text
    ).toBe("good");
    await expect(
      createVenueFetcher(root(), source, {
        fetch: vi.fn().mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { location: "https://unknown.example/private" },
          })
        ),
      }).fetchText(source.calendarUrl)
    ).rejects.toThrow("Unapproved");
    await expect(
      createVenueFetcher(root(), source, {
        maxBytes: 2,
        fetch: vi.fn().mockResolvedValue(new Response("long body")),
      }).fetchText(source.calendarUrl)
    ).rejects.toThrow("byte limit");
  });

  it("never caches an API credential echoed in response links", async () => {
    const directory = root();
    const secret = "test-credential-not-real";
    const client = createVenueFetcher(
      directory,
      { ...source, sourceId: "fillmore-sf" },
      {
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              href: `https://app.ticketmaster.com/?apikey=${secret}`,
            })
          )
        ),
      }
    );
    await client.fetchText(
      `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${secret}`
    );
    for (const filename of readdirSync(join(directory, ".cache/venue-fetch")))
      expect(
        readFileSync(join(directory, ".cache/venue-fetch", filename), "utf8")
      ).not.toContain(secret);
    expect(JSON.stringify(client.observations)).not.toContain(secret);
  });

  it("scrubs URL-encoded and JSON-escaped credentials while keeping JSON valid", async () => {
    const directory = root();
    const secret = 'encoded/credential"\\tail';
    const mixedEscaped = JSON.stringify(secret)
      .slice(1, -1)
      .replace("/", "\\u002F")
      .replace("\\\\", "\\u005C");
    const echoed = `{"href":${JSON.stringify(
      `https://app.ticketmaster.com/?apikey=${encodeURIComponent(secret)}`
    )},"escaped":"${mixedEscaped}"}`;
    const client = createVenueFetcher(
      directory,
      { ...source, sourceId: "fillmore-sf" },
      {
        fetch: vi.fn().mockResolvedValue(new Response(echoed)),
        delayMs: 0,
      }
    );

    const fetched = await client.fetchText(
      `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${encodeURIComponent(secret)}`
    );
    const parsed = JSON.parse(fetched.text) as {
      href: string;
      escaped: string;
    };
    expect(parsed.href).toContain("apikey=REDACTED");
    expect(parsed.escaped).toBe("REDACTED");
    expect(fetched.text).not.toContain(secret);
    expect(fetched.text).not.toContain(encodeURIComponent(secret));
    expect(fetched.text).not.toContain("encoded\\/credential");
    for (const filename of readdirSync(join(directory, ".cache/venue-fetch")))
      expect(
        readFileSync(join(directory, ".cache/venue-fetch", filename), "utf8")
      ).not.toContain(secret);
  });

  it("prefers Last-Modified when a source declares that conditional validator", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("cached body", {
          headers: {
            etag: '"etag-value"',
            "last-modified": "Mon, 07 Sep 2026 12:00:00 GMT",
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const client = createVenueFetcher(
      root(),
      { ...source, conditionalValidator: "last-modified" },
      { fetch, delayMs: 0 }
    );

    await client.fetchText(source.calendarUrl);
    await client.fetchText(source.calendarUrl);
    const headers = fetch.mock.calls[1][1]?.headers as Record<string, string>;
    expect(headers["If-Modified-Since"]).toBe("Mon, 07 Sep 2026 12:00:00 GMT");
    expect(headers["If-None-Match"]).toBeUndefined();
  });
});
