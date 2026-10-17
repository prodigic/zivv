import { chromium, type Browser, type Page } from "playwright";
import { createHash } from "node:crypto";
import type { DataManifest, RecentAdditionsIndex } from "../../types/data.js";
import type { Artist, Event, EventChunk, Venue } from "../../types/events.js";
import {
  getLast7LocalDateWindow,
  isAddedInWindow,
  isEventUpcoming,
  localDateKey,
  sortNewestAddedFirst,
} from "../discovery.js";
import { siteCacheName } from "../../utils/site-base.js";
import { isArtistLink } from "../../utils/artist-links.js";
import { isPosterUrl } from "../../utils/event-poster.js";
import type { ArtistLink } from "../../types/artist-links.js";
import {
  PROMOTION_DESTINATIONS,
  type PromotionDestination,
} from "./promotion-control.js";

export interface BrowserRoute {
  /** Relative to the closed destination's base directory. */
  path: string;
  expectedText: string[];
  /** Exact rendered href attributes; these destinations are never followed. */
  expectedLinks?: string[];
}

export interface ReleaseBrowserPlan {
  expectedDatasetVersion: string;
  routes: BrowserRoute[];
}

export interface ReleaseBrowserInput extends ReleaseBrowserPlan {
  destination: PromotionDestination;
  baseUrl: string;
  prior: { files: ReadonlyMap<string, Buffer>; routes?: BrowserRoute[] };
  /** Whole verification deadline, bounded to five minutes. */
  timeoutMs?: number;
}

export interface BrowserObservation {
  client: "fresh" | "cached";
  viewport: "desktop" | "mobile";
  path: string;
  datasetVersion: string;
  manifestSha256: string;
  expectedText: string[];
  expectedLinks?: string[];
}

export interface ReleaseBrowserResult {
  freshClient: true;
  cachedClient: true;
  routes: true;
  priorDatasetVersion: string;
  observations: BrowserObservation[];
}

function readJson<T>(files: ReadonlyMap<string, Buffer>, path: string): T {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`Browser plan requires retained file ${path}`);
  return JSON.parse(bytes.toString("utf8")) as T;
}

function readDataset(files: ReadonlyMap<string, Buffer>) {
  const manifest = readJson<DataManifest>(files, "data/manifest.json");
  if (!manifest.datasetVersion?.trim())
    throw new Error("Browser verification requires a dataset version");
  const events = manifest.chunks.events.flatMap(
    (chunk) => readJson<EventChunk>(files, `data/${chunk.filename}`).events
  );
  const artists = new Map(
    readJson<Artist[]>(files, `data/${manifest.chunks.artists.filename}`).map(
      (artist) => [Number(artist.id), artist]
    )
  );
  const venues = new Map(
    readJson<Venue[]>(files, `data/${manifest.chunks.venues.filename}`).map(
      (venue) => [Number(venue.id), venue]
    )
  );
  return { manifest, events, artists, venues };
}

function artistRoute(artist: Artist): BrowserRoute {
  const expectedText = [artist.name];
  const reviews =
    artist.vibe?.reviews.filter((review) => isPosterUrl(review.url)) ?? [];
  if (reviews.length && artist.vibe?.summary)
    expectedText.push(artist.vibe.summary);
  // ArtistLinks renders one preferred destination per platform. Match its
  // preference so reviewed album links do not become invented visible anchors.
  const preference = (link: ArtistLink) => {
    const path = new URL(link.url).pathname;
    if (path === "/" || path === "/music" || path.includes("/artist/"))
      return 0;
    return /\/(album|track|watch|release)(?:\/|$)/.test(path) ? 2 : 1;
  };
  const platforms = new Map<ArtistLink["kind"], ArtistLink>();
  for (const link of artist.links?.filter(isArtistLink) ?? []) {
    const current = platforms.get(link.kind);
    if (!current || preference(link) < preference(current))
      platforms.set(link.kind, link);
  }
  const expectedLinks = [
    ...new Set([
      ...reviews.map((review) => review.url),
      ...[...platforms.values()].map((link) => link.url),
    ]),
  ];
  return {
    path: `artists/${artist.slug}`,
    expectedText,
    ...(expectedLinks.length ? { expectedLinks } : {}),
  };
}

function venueRoute(venue: Venue): BrowserRoute {
  return {
    path: `venues/${venue.slug}`,
    expectedText: [
      venue.name,
      ...(venue.address?.trim() ? [venue.address] : []),
    ],
    ...(venue.website ? { expectedLinks: [venue.website] } : {}),
  };
}

function metadataArtist(
  artists: Iterable<Artist>,
  covered?: Artist
): Artist | undefined {
  const hasVibe = (artist: Artist | undefined) =>
    Boolean(
      artist?.vibe?.summary &&
      artist.vibe.reviews.some((review) => isPosterUrl(review.url))
    );
  const hasLinks = (artist: Artist | undefined) =>
    Boolean(artist?.links?.some(isArtistLink));
  const score = (artist: Artist) =>
    Number(!hasVibe(covered) && hasVibe(artist)) +
    Number(!hasLinks(covered) && hasLinks(artist));
  return [...artists]
    .sort((left, right) => score(right) - score(left))
    .find((artist) => score(artist) > 0);
}

function metadataVenue(
  venues: Iterable<Venue>,
  covered?: Venue
): Venue | undefined {
  const score = (venue: Venue) =>
    Number(!covered?.address?.trim() && Boolean(venue.address?.trim())) +
    Number(!covered?.website && Boolean(venue.website));
  return [...venues]
    .sort((left, right) => score(right) - score(left))
    .find((venue) => score(venue) > 0);
}

function isWebLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Derive visible samples or known empty states from the complete retained dataset. */
export function buildReleaseBrowserPlan(
  files: ReadonlyMap<string, Buffer>,
  nowEpochMs: number
): ReleaseBrowserPlan {
  if (!Number.isFinite(nowEpochMs))
    throw new Error("Invalid browser plan time");
  const { manifest, events, artists, venues } = readDataset(files);
  const upcoming = events
    .filter((event) => isEventUpcoming(event, nowEpochMs))
    .sort((left, right) => left.dateEpochMs - right.dateEpochMs);
  const month = localDateKey(nowEpochMs)?.slice(0, 7);
  const current = upcoming.find((event) => event.date.slice(0, 7) === month);
  const future = upcoming.find(
    (event) => event.date.slice(0, 7) > (month ?? "")
  );
  const sample = current ?? future ?? events[0];
  const artist = sample
    ? artists.get(Number(sample.headlinerArtistId))
    : artists.values().next().value;
  const venue = sample
    ? venues.get(Number(sample.venueId))
    : venues.values().next().value;
  if (sample && (!artist?.name || !artist.slug || !venue?.name || !venue.slug))
    throw new Error(
      "Browser verification lacks sample artist or venue identity"
    );
  const name = (event: Event): string => {
    const value = artists.get(Number(event.headlinerArtistId))?.name;
    if (!value) throw new Error(`Missing sample artist for event ${event.id}`);
    return value;
  };
  const edition = manifest.weeklyEdition;
  if (
    !edition ||
    !edition.datasetVersion?.trim() ||
    !Array.isArray(edition.eventIds)
  )
    throw new Error(
      "Browser verification requires matching frozen weekly membership"
    );
  const memberIds = new Set(edition.eventIds);
  const weekly = events.find((event) => memberIds.has(Number(event.id)));
  if (!weekly && memberIds.size)
    throw new Error("Browser verification needs a frozen weekly event sample");
  const weeklyVenue = weekly ? venues.get(Number(weekly.venueId)) : undefined;
  if (weekly && !weeklyVenue?.name)
    throw new Error("Missing frozen weekly venue");
  const recentFile = manifest.chunks.recentAdditions;
  const recent = recentFile
    ? readJson<RecentAdditionsIndex>(files, `data/${recentFile.filename}`)
    : null;
  if (recent && recent.datasetVersion !== manifest.datasetVersion)
    throw new Error(
      "Browser plan recent-additions dataset does not match manifest"
    );
  const recentById = new Map(
    recent?.events.map((entry) => [entry.eventId, entry])
  );
  const window = getLast7LocalDateWindow(nowEpochMs);
  const rolling = sortNewestAddedFirst(
    upcoming.map((event) => ({
      ...event,
      createdAtEpochMs:
        recentById.get(event.id)?.createdAtEpochMs ?? event.createdAtEpochMs,
      addedDateProvenance:
        recentById.get(event.id)?.addedDateProvenance ??
        event.addedDateProvenance,
    }))
  ).find((event) => isAddedInWindow(event, window));
  const sampledArtist = metadataArtist(artists.values()) ?? artist;
  const sampledVenue = metadataVenue(venues.values()) ?? venue;
  const extraArtist = metadataArtist(artists.values(), sampledArtist);
  const extraVenue = metadataVenue(venues.values(), sampledVenue);
  return {
    expectedDatasetVersion: manifest.datasetVersion,
    routes: [
      {
        path: "shows",
        expectedText: upcoming.length
          ? [name(upcoming[0])]
          : ["No events match your filters."],
      },
      ...(current
        ? [
            {
              path: `events/${current.slug}`,
              expectedText: [
                name(current),
                venues.get(Number(current.venueId))!.name,
              ],
            },
          ]
        : []),
      ...(future
        ? [{ path: `events/${future.slug}`, expectedText: [name(future)] }]
        : []),
      sampledArtist
        ? artistRoute(sampledArtist)
        : { path: "artists", expectedText: ["0 artists in the Bay Area"] },
      sampledVenue
        ? venueRoute(sampledVenue)
        : { path: "venues", expectedText: ["0 venues across the Bay Area"] },
      {
        path: "newsletter/bay-area",
        expectedText: [
          "Recently added shows",
          weekly
            ? `${name(weekly)} at ${weeklyVenue!.name}`
            : "No additions this week.",
        ],
      },
      {
        path: "new",
        expectedText: rolling
          ? [name(rolling)]
          : ["No upcoming events were added in this window."],
      },
      ...(extraArtist && extraArtist.id !== sampledArtist?.id
        ? [artistRoute(extraArtist)]
        : []),
      ...(extraVenue && extraVenue.id !== sampledVenue?.id
        ? [venueRoute(extraVenue)]
        : []),
    ],
  };
}

function seedPlan(
  files: ReadonlyMap<string, Buffer>
): ReleaseBrowserPlan & { hasEvents: boolean } {
  const { manifest, events, artists, venues } = readDataset(files);
  const event = events.find(
    (entry) =>
      artists.has(Number(entry.headlinerArtistId)) &&
      venues.has(Number(entry.venueId))
  );
  if (!event && events.length)
    throw new Error(
      "Prior retained dataset has no event to populate its cache"
    );
  return {
    expectedDatasetVersion: manifest.datasetVersion,
    hasEvents: Boolean(event),
    routes: [
      {
        path: event ? `events/${event.slug}` : "shows",
        expectedText: event
          ? [artists.get(Number(event.headlinerArtistId))!.name]
          : ["No events match your filters."],
      },
    ],
  };
}

function validateRoutes(routes: BrowserRoute[]): void {
  if (!routes.length || routes.length > 16)
    throw new Error("Browser route count must be 1..16");
  for (const route of routes) {
    if (
      !/^[A-Za-z0-9_/-]+$/.test(route.path) ||
      route.path.startsWith("/") ||
      route.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      !route.expectedText.length ||
      route.expectedText.some((value) => !value.trim()) ||
      route.expectedLinks?.some((value) => !isWebLink(value))
    )
      throw new Error("Invalid browser route expectation");
  }
}

/**
 * Observe the app's own network manifest and visible content in separate fresh
 * and previously populated IndexedDB contexts at desktop and mobile sizes.
 * Prior data is served only during cache seeding; current checks use the live site.
 */
export async function verifyReleaseBrowser(
  input: ReleaseBrowserInput,
  dependencies: { launchBrowser?: () => Promise<Browser> } = {}
): Promise<ReleaseBrowserResult> {
  const policy = PROMOTION_DESTINATIONS[input.destination];
  if (!policy || input.baseUrl !== policy.liveUrl)
    throw new Error(
      "Browser verifier destination URL must match closed policy"
    );
  if (!input.expectedDatasetVersion.trim())
    throw new Error("Expected dataset version is required");
  validateRoutes(input.routes);
  const prior = seedPlan(input.prior.files);
  const priorRoutes = input.prior.routes ?? prior.routes;
  validateRoutes(priorRoutes);
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error("Browser verification timeout must be 1..300000ms");
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const duration = deadline - Date.now();
    if (duration <= 0)
      throw new Error("Browser verification deadline exceeded");
    return Math.min(duration, 20_000);
  };
  const manifestUrl = new URL("data/manifest.json", input.baseUrl).href;
  const observations: BrowserObservation[] = [];
  const browser = await (
    dependencies.launchBrowser ??
    (() => chromium.launch({ headless: true, timeout: remaining() }))
  )();
  // Enforce the whole deadline, including stuck navigation/cache read operations.
  const deadlineTimer = setTimeout(
    () => {
      void browser.close().catch(() => undefined);
    },
    Math.max(1, deadline - Date.now())
  );
  try {
    for (const viewport of ["desktop", "mobile"] as const) {
      for (const client of ["fresh", "cached"] as const) {
        const context = await browser.newContext({
          viewport:
            viewport === "desktop"
              ? { width: 1440, height: 1000 }
              : { width: 390, height: 844 },
          isMobile: viewport === "mobile",
          hasTouch: viewport === "mobile",
          timezoneId: "America/Los_Angeles",
          locale: "en-US",
          serviceWorkers: "block",
        });
        try {
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const check = async (route: BrowserRoute, version: string) => {
            const responsePromise = page.waitForResponse(
              (response) => response.url() === manifestUrl,
              { timeout: remaining() }
            );
            const [, response] = await Promise.all([
              page.goto(new URL(route.path, input.baseUrl).href, {
                waitUntil: "domcontentloaded",
                timeout: remaining(),
              }),
              responsePromise,
            ]);
            if (!response.ok() || response.fromServiceWorker())
              throw new Error(
                "App manifest was not a successful network response"
              );
            const bytes = await response.body();
            const manifest = JSON.parse(bytes.toString("utf8")) as DataManifest;
            if (manifest.datasetVersion !== version)
              throw new Error(
                `Browser manifest dataset mismatch on ${route.path}`
              );
            const main = page.getByRole("main").first();
            for (const value of route.expectedText) {
              await main
                .getByText(value, { exact: false })
                .first()
                .waitFor({ state: "visible", timeout: remaining() });
            }
            for (const href of route.expectedLinks ?? []) {
              await main
                .locator(`a[href=${JSON.stringify(href)}]`)
                .first()
                .waitFor({ state: "visible", timeout: remaining() });
            }
            if (page.url() !== new URL(route.path, input.baseUrl).href)
              throw new Error("Browser left expected destination route");
            if (errors.length)
              throw new Error(`Browser runtime errors: ${errors.join("; ")}`);
            for (const alert of await page.getByRole("alert").all()) {
              if (await alert.isVisible())
                throw new Error(
                  `Browser displayed an error: ${await alert.innerText()}`
                );
            }
            return createHash("sha256").update(bytes).digest("hex");
          };
          if (client === "cached") {
            const matchData = (url: URL) =>
              url.origin === new URL(input.baseUrl).origin &&
              url.pathname.startsWith(`${policy.basePath}data/`);
            await context.route(matchData, async (route) => {
              const path = new URL(route.request().url()).pathname.slice(
                policy.basePath.length
              );
              const bytes = input.prior.files.get(path);
              if (!bytes) {
                await route.abort("failed");
                return;
              }
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: bytes,
              });
            });
            for (const route of priorRoutes)
              await check(route, prior.expectedDatasetVersion);
            await assertPopulatedCache(
              page,
              siteCacheName(policy.basePath),
              prior.expectedDatasetVersion,
              remaining(),
              prior.hasEvents
            );
            await context.unroute(matchData);
          }
          for (const route of input.routes) {
            const manifestSha256 = await check(
              route,
              input.expectedDatasetVersion
            );
            observations.push({
              client,
              viewport,
              path: route.path,
              datasetVersion: input.expectedDatasetVersion,
              manifestSha256,
              expectedText: [...route.expectedText],
              ...(route.expectedLinks
                ? { expectedLinks: [...route.expectedLinks] }
                : {}),
            });
          }
          await assertPopulatedCache(
            page,
            siteCacheName(policy.basePath),
            input.expectedDatasetVersion,
            remaining(),
            input.routes.some((route) => route.path.startsWith("events/"))
          );
        } finally {
          await context.close();
        }
      }
    }
    return {
      freshClient: true,
      cachedClient: true,
      routes: true,
      priorDatasetVersion: prior.expectedDatasetVersion,
      observations,
    };
  } finally {
    clearTimeout(deadlineTimer);
    await browser.close();
  }
}

async function assertPopulatedCache(
  page: Page,
  dbName: string,
  version: string,
  timeout: number,
  requireEventChunk: boolean
): Promise<void> {
  // String evaluation keeps the Node-only ETL build free of DOM type dependencies.
  await page.waitForFunction(
    `async () => {
    const names = await indexedDB.databases();
    if (!names.some(entry => entry.name === ${JSON.stringify(dbName)})) return false;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(${JSON.stringify(dbName)});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("data")) return false;
      const entries = await new Promise((resolve, reject) => {
        const request = db.transaction("data", "readonly").objectStore("data").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const current = entries.filter(entry => entry.version === ${JSON.stringify(version)});
      return ["manifest", "artists", "venues", "indexes"].every(key => current.some(entry => entry.key === key)) &&
        (!${requireEventChunk} || current.some(entry => entry.key.startsWith("chunk-") && Array.isArray(entry.data.events)));
    } finally { db.close(); }
  }`,
    undefined,
    { timeout }
  );
}
