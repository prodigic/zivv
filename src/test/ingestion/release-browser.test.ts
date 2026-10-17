import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildReleaseBrowserPlan,
  verifyReleaseBrowser,
} from "../../lib/ingestion/release-browser.js";

const now = Date.parse("2026-10-14T18:00:00Z");
const baseUrl = "https://www.prodigic.com/zivv/";
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function dataset(version = "current", name = "Current") {
  return new Map([
    [
      "data/manifest.json",
      json({
        datasetVersion: version,
        chunks: {
          artists: { filename: "artists.json" },
          venues: { filename: "venues.json" },
          indexes: { filename: "indexes.json" },
          events: [
            { filename: "events-2026-10.json" },
            { filename: "events-2026-11.json" },
          ],
        },
        weeklyEdition: {
          datasetVersion: version,
          eventIds: [1],
          editionId: "2026-10-09",
        },
      }),
    ],
    [
      "data/artists.json",
      json([
        {
          id: 10,
          name: `${name} Artist`,
          slug: `${name.toLowerCase()}-artist`,
        },
      ]),
    ],
    [
      "data/venues.json",
      json([
        { id: 20, name: `${name} Venue`, slug: `${name.toLowerCase()}-venue` },
      ]),
    ],
    ["data/indexes.json", json({})],
    ...["10", "11"].map((month, index): [string, Buffer] => [
      `data/events-2026-${month}.json`,
      json({
        events: [
          {
            id: index + 1,
            headlinerArtistId: 10,
            artistIds: [10],
            venueId: 20,
            date: `2026-${month}-20`,
            dateEpochMs: Date.parse(`2026-${month}-20T20:00:00Z`),
            slug: `2026-${month}-20-${name.toLowerCase()}`,
            createdAtEpochMs: now - 86400000,
            addedDateProvenance: "observed",
            timeBasis: "instant",
          },
        ],
      }),
    ]),
  ]);
}

function emptyDataset(version = "current") {
  const files = dataset(version);
  const manifest = JSON.parse(files.get("data/manifest.json")!.toString());
  manifest.weeklyEdition.eventIds = [];
  manifest.chunks.events = [];
  files.set("data/manifest.json", json(manifest));
  files.set("data/artists.json", json([]));
  files.set("data/venues.json", json([]));
  files.set("data/events-2026-10.json", json({ events: [] }));
  files.set("data/events-2026-11.json", json({ events: [] }));
  return files;
}

describe("release browser plan", () => {
  it("derives real current/future, artist/venue, weekly and rolling samples", () => {
    const plan = buildReleaseBrowserPlan(dataset(), now);
    expect(plan.expectedDatasetVersion).toBe("current");
    expect(plan.routes.map((route) => route.path)).toEqual([
      "shows",
      "events/2026-10-20-current",
      "events/2026-11-20-current",
      "artists/current-artist",
      "venues/current-venue",
      "newsletter/bay-area",
      "new",
    ]);
    expect(plan.routes[5].expectedText).toContain(
      "Current Artist at Current Venue"
    );
    expect(plan.routes[6].expectedText).toEqual(["Current Artist"]);
  });

  it("checks an honest rolling empty state independently of frozen weekly membership", () => {
    const files = dataset();
    for (const month of ["10", "11"]) {
      const path = `data/events-2026-${month}.json`;
      const chunk = JSON.parse(files.get(path)!.toString());
      chunk.events[0].createdAtEpochMs = now - 20 * 86400000;
      files.set(path, json(chunk));
    }
    const plan = buildReleaseBrowserPlan(files, now);
    expect(plan.routes[5].expectedText).toContain(
      "Current Artist at Current Venue"
    );
    expect(plan.routes[6].expectedText).toEqual([
      "No upcoming events were added in this window.",
    ]);
  });

  it("omits absent current-month or later-month samples without inventing failures", () => {
    const october30 = buildReleaseBrowserPlan(
      dataset(),
      Date.parse("2026-10-30T18:00:00Z")
    );
    expect(
      october30.routes
        .filter((route) => route.path.startsWith("events/"))
        .map((route) => route.path)
    ).toEqual(["events/2026-11-20-current"]);
    const files = dataset();
    files.set("data/events-2026-11.json", json({ events: [] }));
    expect(
      buildReleaseBrowserPlan(files, now)
        .routes.filter((route) => route.path.startsWith("events/"))
        .map((route) => route.path)
    ).toEqual(["events/2026-10-20-current"]);
    const afterAllShows = buildReleaseBrowserPlan(
      dataset(),
      Date.parse("2027-01-01")
    );
    expect(afterAllShows.routes[0].expectedText).toEqual([
      "No events match your filters.",
    ]);
  });

  it("checks explicit empty states for a legitimately empty catalog and frozen week", () => {
    const plan = buildReleaseBrowserPlan(emptyDataset(), now);
    expect(plan.routes).toEqual([
      { path: "shows", expectedText: ["No events match your filters."] },
      { path: "artists", expectedText: ["0 artists in the Bay Area"] },
      { path: "venues", expectedText: ["0 venues across the Bay Area"] },
      {
        path: "newsletter/bay-area",
        expectedText: ["Recently added shows", "No additions this week."],
      },
      {
        path: "new",
        expectedText: ["No upcoming events were added in this window."],
      },
    ]);
  });

  it("fails closed when a nonempty frozen membership refers to no retained event", () => {
    const files = dataset();
    const manifest = JSON.parse(files.get("data/manifest.json")!.toString());
    manifest.weeklyEdition.eventIds = [999];
    files.set("data/manifest.json", json(manifest));
    expect(() => buildReleaseBrowserPlan(files, now)).toThrow(/frozen weekly/);
  });

  it("retains an edition identity independently of the export dataset timestamp", () => {
    const files = dataset();
    const manifest = JSON.parse(files.get("data/manifest.json")!.toString());
    manifest.weeklyEdition.datasetVersion = "frozen-ingestion-version";
    files.set("data/manifest.json", json(manifest));
    expect(
      buildReleaseBrowserPlan(files, now).routes[5].expectedText
    ).toContain("Current Artist at Current Venue");
  });

  it("checks rendered artist criticism, preferred links, venue address and website", () => {
    const files = dataset();
    const artists = JSON.parse(files.get("data/artists.json")!.toString());
    artists[0].vibe = {
      summary: "A precise review-backed listening guide.",
      reviews: [{ url: "https://reviews.example/review" }],
    };
    artists[0].links = [
      { kind: "bandcamp", url: "https://artist.bandcamp.com/album/work" },
      { kind: "bandcamp", url: "https://artist.bandcamp.com/" },
      { kind: "website", url: "https://artist.example/" },
    ];
    files.set("data/artists.json", json(artists));
    const venues = JSON.parse(files.get("data/venues.json")!.toString());
    venues[0].address = "123 Main Street";
    venues[0].website = "https://venue.example/";
    files.set("data/venues.json", json(venues));
    const plan = buildReleaseBrowserPlan(files, now);
    const artist = plan.routes.find(
      (route) => route.path === "artists/current-artist"
    )!;
    expect(artist.expectedText).toContain(
      "A precise review-backed listening guide."
    );
    expect(artist.expectedLinks).toEqual([
      "https://reviews.example/review",
      "https://artist.bandcamp.com/",
      "https://artist.example/",
    ]);
    const venue = plan.routes.find(
      (route) => route.path === "venues/current-venue"
    )!;
    expect(venue.expectedText).toContain("123 Main Street");
    expect(venue.expectedLinks).toEqual(["https://venue.example/"]);
  });

  it("adds at most two routes when optional metadata is spread across records", () => {
    const files = dataset();
    const artists = JSON.parse(files.get("data/artists.json")!.toString());
    artists[0].vibe = {
      summary: "Criticism sample.",
      reviews: [{ url: "https://reviews.example/review" }],
    };
    artists.push({
      id: 11,
      name: "Linked Artist",
      slug: "linked-artist",
      links: [{ kind: "website", url: "https://artist.example/" }],
    });
    files.set("data/artists.json", json(artists));
    const venues = JSON.parse(files.get("data/venues.json")!.toString());
    venues[0].address = "123 Main Street";
    venues.push({
      id: 21,
      name: "Linked Venue",
      slug: "linked-venue",
      website: "https://venue.example/",
    });
    files.set("data/venues.json", json(venues));
    const plan = buildReleaseBrowserPlan(files, now);
    expect(plan.routes).toHaveLength(9);
    expect(
      plan.routes.find((route) => route.path === "artists/linked-artist")
        ?.expectedLinks
    ).toEqual(["https://artist.example/"]);
    expect(
      plan.routes.find((route) => route.path === "venues/linked-venue")
        ?.expectedLinks
    ).toEqual(["https://venue.example/"]);
  });

  it("rejects off-policy URLs and paths before opening a browser", async () => {
    const input = {
      destination: "production" as const,
      baseUrl,
      ...buildReleaseBrowserPlan(dataset(), now),
      prior: { files: dataset("prior", "Prior") },
    };
    await expect(
      verifyReleaseBrowser({
        ...input,
        baseUrl: "https://attacker.example/zivv/",
      })
    ).rejects.toThrow(/closed policy/);
    await expect(
      verifyReleaseBrowser({
        ...input,
        routes: [{ path: "../outside", expectedText: ["Artist"] }],
      })
    ).rejects.toThrow(/route expectation/);
    await expect(
      verifyReleaseBrowser({ ...input, timeoutMs: 300001 })
    ).rejects.toThrow(/timeout/);
    await expect(
      verifyReleaseBrowser({
        ...input,
        routes: [
          {
            path: "shows",
            expectedText: ["Artist"],
            expectedLinks: ["javascript:alert(1)"],
          },
        ],
      })
    ).rejects.toThrow(/route expectation/);
  });
});

it.runIf(Boolean(process.env.ZIVV_RELEASE_SITE_FIXTURE)).each([false, true])(
  "verifies every derived route against a retained production app (empty=%s)",
  async (empty) => {
    const root = process.env.ZIVV_RELEASE_SITE_FIXTURE!;
    const files = new Map<string, Buffer>();
    async function collect(directory: string, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name;
        if (entry.isDirectory())
          await collect(join(directory, entry.name), path + "/");
        else files.set(path, await readFile(join(directory, entry.name)));
      }
    }
    await collect(root);
    if (empty) {
      const manifest = JSON.parse(files.get("data/manifest.json")!.toString());
      manifest.chunks.events = [];
      manifest.weeklyEdition.eventIds = [];
      manifest.totalEvents = 0;
      manifest.totalArtists = 0;
      manifest.totalVenues = 0;
      files.set("data/manifest.json", json(manifest));
      files.set(`data/${manifest.chunks.artists.filename}`, json([]));
      files.set(`data/${manifest.chunks.venues.filename}`, json([]));
      if (manifest.chunks.recentAdditions)
        files.set(
          `data/${manifest.chunks.recentAdditions.filename}`,
          json({
            schemaVersion: 1,
            datasetVersion: manifest.datasetVersion,
            events: [],
          })
        );
    }
    const plan = buildReleaseBrowserPlan(files, now);
    const browser = await chromium.launch({ headless: true });
    const actualNewContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await actualNewContext(options);
      await context.addInitScript(`Date.now = () => ${now};`);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseUrl).origin) {
          await route.abort();
          return;
        }
        const path = url.pathname.slice("/zivv/".length);
        const bytes =
          files.get(path) ??
          (!path.includes(".") ? files.get("index.html") : undefined);
        const extension = path.split(".").pop();
        const contentType =
          extension === "js"
            ? "application/javascript"
            : extension === "css"
              ? "text/css"
              : extension === "json"
                ? "application/json"
                : "text/html";
        await route.fulfill({
          status: bytes ? 200 : 404,
          contentType,
          body: bytes ?? "missing",
        });
      });
      return context;
    };
    try {
      const result = await verifyReleaseBrowser(
        {
          destination: "production",
          baseUrl,
          ...plan,
          prior: { files },
          timeoutMs: 120000,
        },
        { launchBrowser: async () => browser }
      );
      expect(result.observations).toHaveLength(plan.routes.length * 4);
    } finally {
      await browser.close();
    }
  },
  125000
);

// Opt-in real Chromium fixtures keep the ordinary Node ingestion suite independent
// of local browser installation. Release verification itself never skips Chromium.
describe.runIf(process.env.ZIVV_RELEASE_BROWSER_TESTS === "1")(
  "release browser isolated Chromium fixture",
  () => {
    let browser: Browser | undefined;
    afterEach(async () => {
      await browser?.close();
    });

    async function fixture(
      ignoreCacheVersion = false,
      currentFiles = dataset()
    ) {
      browser = await chromium.launch({ headless: true });
      const actualNewContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await actualNewContext(options);
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== new URL(baseUrl).origin) {
            await route.abort();
            return;
          }
          const path = url.pathname.slice("/zivv/".length);
          if (path.startsWith("data/")) {
            const bytes = currentFiles.get(path);
            await route.fulfill({
              status: bytes ? 200 : 404,
              body: bytes ?? "missing",
              contentType: "application/json",
            });
            return;
          }
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><body><script>
          (async () => {
            const manifest = await (await fetch('/zivv/data/manifest.json')).json();
            const db = await new Promise((resolve, reject) => {
              const request = indexedDB.open('zivv-data-v6', 1);
              request.onupgradeneeded = () => request.result.createObjectStore('data', { keyPath: 'key' });
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            async function read(key) {
              return new Promise(resolve => { const r = db.transaction('data').objectStore('data').get(key); r.onsuccess = () => resolve(r.result); });
            }
            async function put(key, data) {
              await new Promise(resolve => { const tx = db.transaction('data','readwrite'); tx.objectStore('data').put({key, data, version: manifest.datasetVersion}); tx.oncomplete = resolve; });
            }
            await put('manifest', manifest);
            async function load(key, file) {
              const cached = await read(key);
              if (cached && (${ignoreCacheVersion} || cached.version === manifest.datasetVersion)) return cached.data;
              const data = await (await fetch('/zivv/data/' + file)).json(); await put(key, data); return data;
            }
            const artists = await load('artists', 'artists.json');
            const venues = await load('venues', 'venues.json');
            await load('indexes', 'indexes.json');
            await load('chunk-2026-10', 'events-2026-10.json');
            document.body.innerHTML = artists.length && venues.length
              ? '<main><h1>' + artists[0].name + ' at ' + venues[0].name + '</h1><p>Recently added shows</p></main>'
              : '<main><p>No events match your filters.</p><p>0 artists in the Bay Area</p><p>0 venues across the Bay Area</p><p>Recently added shows</p><p>No additions this week.</p><p>No upcoming events were added in this window.</p></main>';
            db.close();
          })().catch(error => { throw error; });
        </script></body>`,
          });
        });
        return context;
      };
      return browser;
    }

    it("observes new manifests and visible data after a real prior IndexedDB cache", async () => {
      const plan = buildReleaseBrowserPlan(dataset(), now);
      const result = await verifyReleaseBrowser(
        {
          destination: "production",
          baseUrl,
          ...plan,
          prior: { files: dataset("prior", "Prior") },
          timeoutMs: 30000,
        },
        { launchBrowser: () => fixture() }
      );
      expect(result.priorDatasetVersion).toBe("prior");
      expect(result.observations).toHaveLength(28);
      expect(
        new Set(
          result.observations.map(
            (entry) => `${entry.viewport}:${entry.client}`
          )
        )
      ).toEqual(
        new Set([
          "mobile:fresh",
          "mobile:cached",
          "desktop:fresh",
          "desktop:cached",
        ])
      );
      expect(
        result.observations.every(
          (entry) =>
            entry.datasetVersion === "current" &&
            /^[a-f0-9]{64}$/.test(entry.manifestSha256)
        )
      ).toBe(true);
    }, 35000);

    it("fails when a new network manifest leaves stale prior data visible", async () => {
      await expect(
        verifyReleaseBrowser(
          {
            destination: "production",
            baseUrl,
            expectedDatasetVersion: "current",
            routes: [{ path: "shows", expectedText: ["Current Artist"] }],
            prior: { files: dataset("prior", "Prior") },
            timeoutMs: 4000,
          },
          { launchBrowser: () => fixture(true) }
        )
      ).rejects.toThrow();
    }, 10000);

    it("exercises a populated cache even when the prior dataset identity is unchanged", async () => {
      const result = await verifyReleaseBrowser(
        {
          destination: "production",
          baseUrl,
          expectedDatasetVersion: "current",
          routes: [{ path: "shows", expectedText: ["Current Artist"] }],
          prior: { files: dataset() },
          timeoutMs: 15000,
        },
        { launchBrowser: () => fixture() }
      );
      expect(result.cachedClient).toBe(true);
      expect(result.priorDatasetVersion).toBe("current");
    }, 20000);

    it("verifies a legitimately empty catalog after seeding an empty prior cache", async () => {
      const files = emptyDataset();
      const result = await verifyReleaseBrowser(
        {
          destination: "production",
          baseUrl,
          ...buildReleaseBrowserPlan(files, now),
          prior: { files: emptyDataset("prior-empty") },
          timeoutMs: 15000,
        },
        { launchBrowser: () => fixture(false, files) }
      );
      expect(result.cachedClient).toBe(true);
      expect(result.priorDatasetVersion).toBe("prior-empty");
      expect(result.observations).toHaveLength(20);
    }, 20000);
  }
);
