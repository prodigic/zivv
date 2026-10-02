import test from "node:test";
import assert from "node:assert/strict";
import { assessLedger } from "./ledger-regression.mjs";

function event(id = 1, createdAtEpochMs = 100) {
  return {
    id,
    title: "A local show",
    createdAtEpochMs,
    firstImportedBy: "steveslist",
    addedDateProvenance: "observed",
    firstImportRunId: "original",
    firstObservedAtEpochMs: createdAtEpochMs,
    sources: [
      {
        kind: "steveslist",
        sourceId: "weekly",
        externalEventId: `show-${id}`,
        canonicalUrl: null,
        originalVenueId: 7,
        session: null,
        firstSeenAtEpochMs: createdAtEpochMs,
        lastSeenAtEpochMs: 300,
        firstSeenRunId: "original",
        lastSeenRunId: "original",
      },
    ],
    provenanceConflicts: [],
  };
}

function catalog() {
  return {
    schemaVersion: 1,
    version: "1",
    migration: { basis: "legacy", migratedAtEpochMs: 10 },
    migrationBasis: "legacy",
    events: [event()],
    artists: [{ id: 3, name: "Local" }],
    venues: [{ id: 7, city: "Berkeley" }],
    redirects: [],
    runs: [
      {
        runId: "original",
        origin: "steveslist",
        sourceId: "weekly",
        contentHash: "a",
        observedAtEpochMs: 100,
        status: "committed",
        committedAtEpochMs: 100,
        publishedAtEpochMs: null,
      },
    ],
  };
}

function permit(collection, id, operation, fields) {
  return {
    collection,
    id,
    operation,
    ...(fields ? { fields } : {}),
    reason: "Reviewed task evidence",
  };
}

function check(before, after, ...changes) {
  return assessLedger(before, after, { schemaVersion: 1, changes });
}

const has = (result, code) =>
  result.violations.some((violation) => violation.code === code);

test("unchanged committed catalog passes without count assumptions", () => {
  const baseline = catalog();
  assert.equal(check(baseline, structuredClone(baseline)).passed, true);
});

test("existing repair labels and appended revisions remain valid", () => {
  const baseline = catalog();
  baseline.version = "12.hopmonk-city-repair.death-from-above-repair";
  assert.equal(check(baseline, structuredClone(baseline)).passed, true);
  const next = structuredClone(baseline);
  next.version += ".5";
  next.venues[0].city = "Oakland";
  assert.equal(
    check(baseline, next, permit("venues", 7, "update", ["city"])).passed,
    true
  );
  next.version = "12";
  assert.equal(
    has(
      check(baseline, next, permit("venues", 7, "update", ["city"])),
      "invalid-revision"
    ),
    true
  );
});

test("a revision cannot silently change when the catalog is unchanged", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.version = "2";
  assert.equal(
    has(check(baseline, next), "unexpected-revision-only-change"),
    true
  );
});

test("a permitted city correction passes with the exact changed fields", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.venues[0].city = "Oakland";
  next.version = "2";
  assert.equal(
    check(baseline, next, permit("venues", 7, "update", ["city"])).passed,
    true
  );
});

test("an unrelated edit on an otherwise permitted event is rejected", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.events[0].title = "Correct title";
  next.events[0].venueId = 55;
  assert.equal(
    has(
      check(baseline, next, permit("events", 1, "update", ["title"])),
      "unexpected-change"
    ),
    true
  );
});

test("replacement preserving total counts still reveals lost and unexpected IDs", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.events = [event(9)];
  const result = check(baseline, next);
  assert.equal(has(result, "lost-event"), true);
  assert.equal(result.changes.length, 2);
});

test("even a permitted event deletion needs a merge redirect", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.events = [];
  assert.equal(
    has(check(baseline, next, permit("events", 1, "remove")), "lost-event"),
    true
  );
});

test("dates added cannot be reset by allowing that field", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.events[0].createdAtEpochMs = 1000;
  assert.equal(
    has(
      check(
        baseline,
        next,
        permit("events", 1, "update", ["createdAtEpochMs"])
      ),
      "changed-first-added"
    ),
    true
  );
});

test("dropping source history fails even when sources are expected to change", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.events[0].sources = [];
  assert.equal(
    has(
      check(baseline, next, permit("events", 1, "update", ["sources"])),
      "lost-source-history"
    ),
    true
  );
});

test("new evidence may enrich a source and advance its last observation", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.events[0].sources[0].canonicalUrl = "https://venue.example/show";
  next.events[0].sources[0].lastSeenAtEpochMs = 400;
  assert.equal(
    check(baseline, next, permit("events", 1, "update", ["sources"])).passed,
    true
  );
});

test("source identity swaps and regressing observation times fail", () => {
  for (const [field, value] of [
    ["externalEventId", "another-show"],
    ["lastSeenAtEpochMs", 1],
    ["firstSeenRunId", "new-run"],
  ]) {
    const baseline = catalog(),
      next = structuredClone(baseline);
    next.events[0].sources[0][field] = value;
    assert.equal(
      has(
        check(baseline, next, permit("events", 1, "update", ["sources"])),
        "lost-source-history"
      ),
      true
    );
  }
});

test("provenance conflicts survive subsequent corrections", () => {
  const baseline = catalog();
  baseline.events[0].provenanceConflicts = [
    { field: "venueId", existingValue: 7, incomingValue: 8 },
  ];
  const next = structuredClone(baseline);
  next.events[0].provenanceConflicts = [];
  assert.equal(
    has(
      check(
        baseline,
        next,
        permit("events", 1, "update", ["provenanceConflicts"])
      ),
      "lost-conflict-history"
    ),
    true
  );
});

test("a duplicate merge retains the earliest contributor and every source", () => {
  const baseline = catalog();
  baseline.events.push(event(2, 50));
  const next = structuredClone(baseline);
  next.events = [
    {
      ...baseline.events[1],
      id: 1,
      sources: [...baseline.events[0].sources, ...baseline.events[1].sources],
    },
  ];
  next.redirects = [
    {
      fromEventId: 2,
      toEventId: 1,
      reason: "duplicate-merge",
      createdAtEpochMs: 500,
    },
  ];
  const changes = [
    permit("events", 1, "update", [
      "createdAtEpochMs",
      "firstObservedAtEpochMs",
      "sources",
    ]),
    permit("events", 2, "remove"),
    permit("redirects", 2, "add"),
  ];
  assert.equal(check(baseline, next, ...changes).passed, true);
  next.events[0].createdAtEpochMs = 100;
  assert.equal(
    has(check(baseline, next, ...changes), "changed-first-added"),
    true
  );
});

test("retired IDs cannot reappear even if their resurrection is permitted", () => {
  const baseline = catalog();
  baseline.redirects = [
    {
      fromEventId: 2,
      toEventId: 1,
      reason: "duplicate-merge",
      createdAtEpochMs: 500,
    },
  ];
  const next = structuredClone(baseline);
  next.events.push(event(2));
  next.redirects = [];
  const result = check(
    baseline,
    next,
    permit("events", 2, "add"),
    permit("redirects", 2, "remove")
  );
  assert.equal(has(result, "retired-id-revived"), true);
  assert.equal(has(result, "lost-redirect"), true);
});

test("cyclic and dangling redirect targets are rejected", () => {
  for (const toEventId of [2, 999]) {
    const baseline = catalog(),
      next = structuredClone(baseline);
    next.redirects = [
      {
        fromEventId: 2,
        toEventId,
        reason: "duplicate-merge",
        createdAtEpochMs: 500,
      },
    ];
    assert.equal(
      has(
        check(baseline, next, permit("redirects", 2, "add")),
        "invalid-redirect"
      ),
      true
    );
  }
});

test("an existing redirect cannot be reassigned to an unrelated event", () => {
  const baseline = catalog();
  baseline.events.push(event(3));
  baseline.redirects = [
    {
      fromEventId: 2,
      toEventId: 1,
      reason: "duplicate-merge",
      createdAtEpochMs: 500,
    },
  ];
  const next = structuredClone(baseline);
  next.redirects[0].toEventId = 3;
  assert.equal(
    has(
      check(baseline, next, permit("redirects", 2, "update", ["toEventId"])),
      "redirect-target-changed"
    ),
    true
  );
});

test("original import receipts cannot be erased or rewritten", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.runs = [];
  assert.equal(
    has(
      check(baseline, next, permit("runs", "original", "remove")),
      "lost-receipt"
    ),
    true
  );
  next.runs = structuredClone(baseline.runs);
  next.runs[0].observedAtEpochMs = 900;
  assert.equal(
    has(
      check(
        baseline,
        next,
        permit("runs", "original", "update", ["observedAtEpochMs"])
      ),
      "rewritten-receipt"
    ),
    true
  );
});

test("receipt publication may advance but cannot return to reconciled", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.runs[0].status = "published";
  next.runs[0].publishedAtEpochMs = 500;
  assert.equal(
    check(
      baseline,
      next,
      permit("runs", "original", "update", ["status", "publishedAtEpochMs"])
    ).passed,
    true
  );
  next.runs[0].status = "reconciled";
  assert.equal(
    has(
      check(
        baseline,
        next,
        permit("runs", "original", "update", ["status", "publishedAtEpochMs"])
      ),
      "receipt-status-regressed"
    ),
    true
  );
});

test("missing expected changes, migration changes and decreasing revisions fail", () => {
  const baseline = catalog(),
    next = structuredClone(baseline);
  next.version = "0";
  next.migration.migratedAtEpochMs = 999;
  const result = check(baseline, next, permit("venues", 7, "update", ["city"]));
  for (const code of [
    "expected-change-missing",
    "changed-migration",
    "invalid-revision",
  ])
    assert.equal(has(result, code), true);
});

test("malformed, duplicate or wildcard permissions fail closed", () => {
  const baseline = catalog();
  assert.throws(() => assessLedger(baseline, baseline, {}));
  assert.throws(() =>
    check(baseline, baseline, permit("events", 1, "update", ["*"]))
  );
  assert.throws(() =>
    check(
      baseline,
      baseline,
      permit("events", 1, "remove"),
      permit("events", 1, "remove")
    )
  );
});
