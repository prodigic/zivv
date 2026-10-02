import { readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

const collections = {
  events: "id",
  artists: "id",
  venues: "id",
  runs: "runId",
  redirects: "fromEventId",
};

/** Stable comparison independent of object property order. */
function stable(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  );
}

const equal = (a, b) => stable(a) === stable(b);
const keyOf = (collection, id) => `${collection}:${JSON.stringify(id)}`;

/** Validate a narrow, explicitly reviewed list; malformed permissions fail closed. */
function permissions(input) {
  if (input?.schemaVersion !== 1 || !Array.isArray(input.changes))
    throw new Error("Expected schemaVersion 1 and a changes array.");
  const result = new Map();
  for (const entry of input.changes) {
    if (
      !Object.hasOwn(collections, entry.collection) ||
      !["add", "update", "remove"].includes(entry.operation) ||
      !["string", "number"].includes(typeof entry.id) ||
      !String(entry.id).length ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      Object.keys(entry).some(
        (field) =>
          !["collection", "id", "operation", "fields", "reason"].includes(field)
      )
    )
      throw new Error("Invalid expected-change entry.");
    const fields = entry.fields;
    if (entry.operation === "update") {
      if (
        !Array.isArray(fields) ||
        !fields.length ||
        fields.some(
          (field) => typeof field !== "string" || !field || field.includes("*")
        ) ||
        new Set(fields).size !== fields.length
      )
        throw new Error("Updates need specific, unique field names.");
    } else if (fields !== undefined) {
      throw new Error("Only updates may specify fields.");
    }
    const key = keyOf(entry.collection, entry.id);
    if (result.has(key)) throw new Error("Duplicate expected-change entry.");
    result.set(key, entry);
  }
  return result;
}

/** Compare full catalogs and protect history, independently of total counts. */
export function assessLedger(
  before,
  after,
  expected = { schemaVersion: 1, changes: [] }
) {
  const allowed = permissions(expected);
  const violations = [];
  const changes = [];
  const issue = (code, collection, id, field) =>
    violations.push({ code, collection, id, ...(field ? { field } : {}) });
  const maps = {};
  for (const [collection, idField] of Object.entries(collections)) {
    const old = new Map(before[collection].map((row) => [row[idField], row]));
    const next = new Map(after[collection].map((row) => [row[idField], row]));
    maps[collection] = { old, next };
    if (
      old.size !== before[collection].length ||
      next.size !== after[collection].length
    )
      issue("duplicate-id", collection, null);
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(id),
        b = next.get(id);
      if (equal(a, b)) continue;
      const operation = !a ? "add" : !b ? "remove" : "update";
      const fields =
        operation === "update"
          ? [...new Set([...Object.keys(a), ...Object.keys(b)])]
              .filter((field) => !equal(a[field], b[field]))
              .sort()
          : [];
      const change = { collection, id, operation, fields };
      changes.push(change);
      const permission = allowed.get(keyOf(collection, id));
      if (
        !permission ||
        permission.operation !== operation ||
        (operation === "update" &&
          !equal([...permission.fields].sort(), fields))
      )
        issue("unexpected-change", collection, id);
      allowed.delete(keyOf(collection, id));
    }
  }
  for (const entry of allowed.values())
    issue("expected-change-missing", entry.collection, entry.id);
  for (const field of ["schemaVersion", "migration", "migrationBasis"])
    if (!equal(before[field], after[field]))
      issue("changed-migration", "ledger", null, field);
  const revisionFollows =
    before.version === after.version ||
    (/^\d+$/.test(before.version) &&
      /^\d+$/.test(after.version) &&
      BigInt(after.version) > BigInt(before.version)) ||
    (after.version.startsWith(`${before.version}.`) &&
      after.version.length > before.version.length + 1);
  if (!revisionFollows) issue("invalid-revision", "ledger", null, "version");
  if (!changes.length && before.version !== after.version)
    issue("unexpected-revision-only-change", "ledger", null, "version");
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (
      !Object.hasOwn(collections, field) &&
      !["schemaVersion", "version", "migration", "migrationBasis"].includes(
        field
      ) &&
      !equal(before[field], after[field])
    )
      issue("unexpected-header-change", "ledger", null, field);

  const redirects = maps.redirects.next;
  function destination(id) {
    const visited = new Set();
    while (redirects.has(id)) {
      if (visited.has(id)) return null;
      visited.add(id);
      id = redirects.get(id).toEventId;
    }
    return maps.events.next.has(id) ? id : null;
  }
  for (const [id] of redirects) {
    if (maps.events.next.has(id)) issue("retired-id-revived", "events", id);
    if (destination(id) === null) issue("invalid-redirect", "redirects", id);
  }
  for (const [id, redirect] of maps.redirects.old) {
    const next = redirects.get(id);
    if (!next) issue("lost-redirect", "redirects", id);
    else
      for (const field of ["reason", "createdAtEpochMs"])
        if (!equal(redirect[field], next[field]))
          issue("rewritten-redirect-history", "redirects", id, field);
    if (next && destination(redirect.toEventId) !== destination(id))
      issue("redirect-target-changed", "redirects", id, "toEventId");
    if (maps.events.next.has(id)) issue("retired-id-revived", "events", id);
  }

  const ancestors = new Map();
  for (const [id, old] of maps.events.old) {
    const target = maps.events.next.has(id) ? id : destination(id);
    if (target === null) {
      issue("lost-event", "events", id);
      continue;
    }
    if (!ancestors.has(target)) ancestors.set(target, []);
    ancestors.get(target).push(old);
  }
  for (const [target, group] of ancestors) {
    const current = maps.events.next.get(target);
    const known = group.filter(
      (row) => row.addedDateProvenance !== "unknown" && row.createdAtEpochMs > 0
    );
    const earliest = (known.length ? known : group).reduce((a, b) =>
      a.createdAtEpochMs <= b.createdAtEpochMs ? a : b
    );
    for (const field of [
      "createdAtEpochMs",
      "firstImportedBy",
      "addedDateProvenance",
      "firstImportRunId",
    ])
      if (!equal(earliest[field], current[field]))
        issue("changed-first-added", "events", target, field);
    for (const old of group) {
      if (
        old.firstObservedAtEpochMs !== null &&
        (current.firstObservedAtEpochMs === null ||
          current.firstObservedAtEpochMs > old.firstObservedAtEpochMs)
      )
        issue(
          "lost-first-observation",
          "events",
          old.id,
          "firstObservedAtEpochMs"
        );
      for (const conflict of old.provenanceConflicts)
        if (!current.provenanceConflicts.some((item) => equal(item, conflict)))
          issue(
            "lost-conflict-history",
            "events",
            old.id,
            "provenanceConflicts"
          );
      for (const source of old.sources) {
        const candidates = current.sources.filter((candidate) =>
          [
            "kind",
            "sourceId",
            "externalEventId",
            "canonicalUrl",
            "originalVenueId",
            "session",
          ].every(
            (field) =>
              source[field] === null || equal(source[field], candidate[field])
          )
        );
        const retained = candidates.some(
          (candidate) =>
            (source.firstSeenAtEpochMs === null ||
              (candidate.firstSeenAtEpochMs !== null &&
                candidate.firstSeenAtEpochMs <= source.firstSeenAtEpochMs)) &&
            (source.lastSeenAtEpochMs === null ||
              (candidate.lastSeenAtEpochMs !== null &&
                candidate.lastSeenAtEpochMs >= source.lastSeenAtEpochMs)) &&
            (source.firstSeenRunId === null ||
              source.firstSeenRunId === candidate.firstSeenRunId)
        );
        if (!retained)
          issue("lost-source-history", "events", old.id, "sources");
      }
    }
  }
  for (const [id, old] of maps.runs.old) {
    const current = maps.runs.next.get(id);
    if (!current) {
      issue("lost-receipt", "runs", id);
      continue;
    }
    for (const field of Object.keys(old)) {
      if (
        !["status", "committedAtEpochMs", "publishedAtEpochMs"].includes(
          field
        ) &&
        !equal(old[field], current[field])
      )
        issue("rewritten-receipt", "runs", id, field);
    }
    for (const field of ["committedAtEpochMs", "publishedAtEpochMs"])
      if (
        old[field] !== null &&
        (current[field] === null || current[field] < old[field])
      )
        issue("receipt-time-regressed", "runs", id, field);
    const stages = ["reconciled", "committed", "published"];
    if (
      stages.includes(old.status) &&
      (!stages.includes(current.status) ||
        stages.indexOf(current.status) < stages.indexOf(old.status))
    )
      issue("receipt-status-regressed", "runs", id, "status");
  }
  return { passed: !violations.length, changes, violations };
}

/** Runtime paths come from the selected checkout, never a fixed worktree. */
async function runtime(root) {
  const module = (name) =>
    import(pathToFileURL(join(root, "dist/lib/ingestion", `${name}.js`)).href);
  const [location, store, ledger, encryption] = await Promise.all([
    module("store-location"),
    module("sqlite-store"),
    module("ledger"),
    module("encrypted-backup"),
  ]);
  const target = location.projectLedgerLocation(root);
  if (target.backend !== "sqlite")
    throw new Error("Checkout must use the shared SQLite store.");
  return { ...store, ...ledger, ...encryption, target };
}

function counts(ledger) {
  return Object.fromEntries(
    Object.keys(collections).map((name) => [name, ledger[name].length])
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      baseline: { type: "string" },
      allowlist: { type: "string" },
    },
  });
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["capture", "check"].includes(command) ||
    !values.root
  )
    throw new Error(
      "Use capture --root ROOT or check --root ROOT --baseline PATH [--allowlist PATH]."
    );
  if (command === "capture" && (values.baseline || values.allowlist))
    throw new Error("Capture does not accept a baseline or allowlist.");
  if (command === "check" && !values.baseline)
    throw new Error("Check requires a baseline.");
  const api = await runtime(resolve(values.root));
  api.checkStore(api.target.path);
  const current = api.readSqliteLedger(api.target.path);
  api.validateLedger(current);
  const key = api.loadBackupKey(api.target.directory);
  const revision = api.ledgerDigest(current);
  const directory = join(api.target.directory, "consolidation");
  if (command === "capture") {
    api.secureOperatorDirectory(directory);
    const baseline = join(
      directory,
      `${Date.now()}-${randomUUID()}.snapshot.enc`
    );
    const encrypted = api.encryptLedgerSnapshot(current, key);
    if (
      api.ledgerDigest(api.decryptLedgerSnapshot(encrypted, key)) !== revision
    )
      throw new Error("Encrypted baseline did not round-trip.");
    api.writeDurableFile(baseline, encrypted);
    api.writeDurableFile(
      `${baseline}.json`,
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          databasePath: api.target.path,
          revision,
          capturedAt: new Date().toISOString(),
        }) + "\n"
      )
    );
    console.log(
      JSON.stringify(
        {
          baseline,
          databasePath: api.target.path,
          revision,
          counts: counts(current),
        },
        null,
        2
      )
    );
    return;
  }
  const baseline = resolve(values.baseline);
  const within = relative(directory, baseline);
  if (!within || within.startsWith("..") || isAbsolute(within))
    throw new Error(
      "Baseline must be in this operator's private consolidation directory."
    );
  const metadata = JSON.parse(readFileSync(`${baseline}.json`, "utf8"));
  const before = api.decryptLedgerSnapshot(readFileSync(baseline), key);
  if (
    metadata.schemaVersion !== 1 ||
    metadata.databasePath !== api.target.path ||
    metadata.revision !== api.ledgerDigest(before)
  )
    throw new Error("Baseline identity or digest does not match.");
  const expected = values.allowlist
    ? JSON.parse(readFileSync(values.allowlist, "utf8"))
    : undefined;
  const result = assessLedger(before, current, expected);
  console.log(
    JSON.stringify(
      {
        ...result,
        beforeRevision: metadata.revision,
        afterRevision: revision,
        beforeCounts: counts(before),
        afterCounts: counts(current),
      },
      null,
      2
    )
  );
  if (!result.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Ledger guard failed: ${error.message}`);
    process.exitCode = 1;
  });
}
