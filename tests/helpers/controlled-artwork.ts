import type { Page, Request } from "@playwright/test";

/**
 * Issue #104: cross-origin show artwork (seetickets.us, ticketm.net,
 * ticketweb.com, axs.com, imgix.net, ...) is optional third-party media.
 * Rendered `<img>` requests to those hosts can stall from a hosted CI
 * runner, which keeps `page.waitForLoadState("networkidle")` unsatisfied
 * for the full 30s test timeout. This isolation answers every cross-origin
 * image request with a controlled local response while leaving every
 * app-owned request (JS/CSS/data/search) on the real network, the same
 * rule smoke tests adopted in issue #98.
 */

/** Tiny valid image used as the controlled cross-origin artwork response. */
export const controlledArtworkSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><rect width="1" height="1" fill="#000"/></svg>';

/** Header tags responses produced by this isolation so recordings can
 * distinguish a controlled response from real third-party network traffic. */
const controlledResponseHeader = "x-zivv-controlled-artwork";

export type NetworkRequestOutcome =
  | "fulfilled-controlled"
  | "completed"
  | "failed";

export interface NetworkRequestRecord {
  url: string;
  resourceType: string;
  /** "app" = same origin as the app under test; "cross" = third party. */
  origin: "app" | "cross";
  outcome: NetworkRequestOutcome;
  status: number | null;
  durationMs: number | null;
}

export interface ThirdPartyArtworkIsolationRecorder {
  records(): readonly NetworkRequestRecord[];
  /** Cross-origin images answered by the controlled response. */
  controlledExternalImages(): readonly NetworkRequestRecord[];
  /** App-owned requests observed on the real network. */
  appOwnedRequests(): readonly NetworkRequestRecord[];
}

interface IsolationState {
  records: NetworkRequestRecord[];
  /** request object -> index into records (parallel-safe per page). */
  recordIndex: Map<Request, number>;
  /** request object -> wall clock start time for duration accounting. */
  startedAt: Map<Request, number>;
}

const isolationByPage = new WeakMap<Page, IsolationState>();

const clampDuration = (start: number | undefined): number | null =>
  start === undefined ? null : Math.max(0, Date.now() - start);

function recorderFor(state: IsolationState): ThirdPartyArtworkIsolationRecorder {
  return {
    records: () => state.records.slice(),
    controlledExternalImages: () =>
      state.records.filter(
        (record) => record.outcome === "fulfilled-controlled"
      ),
    appOwnedRequests: () =>
      state.records.filter((record) => record.origin === "app"),
  };
}

/**
 * Resolve the record slot for a request, creating one on first sight.
 * Kept in one place so both the route fulfillment path and the plain
 * network event path share the same dedupe.
 */
function slotFor(
  state: IsolationState,
  request: Request,
  classifyOrigin: (url: string) => "app" | "cross"
): NetworkRequestRecord {
  const existingIndex = state.recordIndex.get(request);
  if (existingIndex !== undefined) return state.records[existingIndex];
  const url = request.url();
  const record: NetworkRequestRecord = {
    url,
    resourceType: request.resourceType(),
    origin: classifyOrigin(url),
    outcome: "completed",
    status: null,
    durationMs: clampDuration(state.startedAt.get(request)),
  };
  state.records.push(record);
  state.recordIndex.set(request, state.records.length - 1);
  return record;
}

/**
 * Install the cross-origin artwork isolation for this page. App-owned
 * requests stay real; only external image requests are answered locally.
 * Safe to call once per test page from a beforeEach hook.
 */
export function isolateThirdPartyArtwork(
  page: Page,
  appOrigin: string
): ThirdPartyArtworkIsolationRecorder {
  const classifyOrigin = (url: string): "app" | "cross" => {
    try {
      return new URL(url).origin === appOrigin ? "app" : "cross";
    } catch {
      return "cross";
    }
  };
  const state: IsolationState = {
    records: [],
    recordIndex: new Map(),
    startedAt: new Map(),
  };
  isolationByPage.set(page, state);

  page.on("request", (request) => {
    state.startedAt.set(request, Date.now());
    // Records are created lazily by slotFor() from completion events to
    // avoid double-counting the route-fulfilled path.
  });

  page.on("requestfinished", async (request) => {
    const record = slotFor(state, request, classifyOrigin);
    record.durationMs = clampDuration(state.startedAt.get(request));
    try {
      const response = await request.response();
      if (response && record.status === null) {
        record.status = response.status();
        const marked = response.headers()[controlledResponseHeader];
        if (marked) record.outcome = "fulfilled-controlled";
      }
    } catch {
      record.status = null;
    }
  });

  page.on("requestfailed", (request) => {
    const record = slotFor(state, request, classifyOrigin);
    record.outcome = "failed";
    record.status = null;
    record.durationMs = clampDuration(state.startedAt.get(request));
  });

  page.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    let protocol: string | null = null;
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = null;
    }
    if (
      request.resourceType() === "image" &&
      protocol !== null &&
      ["http:", "https:"].includes(protocol) &&
      classifyOrigin(url) === "cross"
    ) {
      state.startedAt.set(request, Date.now());
      // Route-fulfilled requests do not reliably emit completion events,
      // so record the controlled outcome here; the finished handler only
      // enriches it if its completion event arrives later.
      const record = slotFor(state, request, classifyOrigin);
      record.outcome = "fulfilled-controlled";
      record.status = 200;
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: controlledArtworkSvg,
        headers: {
          [controlledResponseHeader]: "zivv-artwork-isolation",
        },
      });
      return;
    }
    await route.continue();
  });

  return recorderFor(state);
}

/** Recorder for a page whose beforeEach already installed the isolation. */
export function thirdPartyArtworkIsolation(
  page: Page
): ThirdPartyArtworkIsolationRecorder {
  const state = isolationByPage.get(page);
  if (!state) {
    throw new Error(
      "isolateThirdPartyArtwork(page, appOrigin) was not installed for this page yet"
    );
  }
  return recorderFor(state);
}
