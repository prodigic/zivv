import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { decryptOperatorRecovery } from "./operator-recovery.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { compiledEtlDigest } from "./source-build.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";

type DirectoryField =
  | "export.workDirectory"
  | "capture.directory"
  | "capture.sourceRoot";
type SqlValue = string | number | null | Buffer;
const maxFileBytes = 512 * 1024 * 1024;
const requiredBeforeActivation = [
  "reviewed-executor-binding",
  "execution-tool-binding",
  "working-key-installation",
  "authoritative-git-checkout",
  "old-installation-fencing",
  "remote-ownership-reconciliation",
  "fresh-environment-resume-drills",
] as const;

export interface RecoveryLocationReport {
  status: "inspected";
  activationAllowed: false;
  checkpointSha256: string;
  ledgerRevision: string;
  fileCount: number;
  directoryCount: number;
  runtime: {
    nodeMatches: boolean;
    icuMatches: boolean;
    executableMatches: boolean;
    workerMatches: boolean;
    lockfileMatches: boolean;
    npmIdentity: "not-retained" | "retained-build-identities";
  };
  requiredBeforeActivation: readonly string[];
}
export interface RecoveryLocationContext {
  readonly report: RecoveryLocationReport;
  readOriginalFile(originalAbsolutePath: string): Buffer;
  resolveOriginalDirectory(
    field: DirectoryField,
    originalAbsolutePath: string
  ): string;
}
function fail(): never {
  throw new Error("INVALID_RECOVERY_LOCATION");
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail();
}
function regular(path: string, limit = maxFileBytes): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    fail();
  return readFileSync(path);
}
function noLinks(path: string): void {
  for (let item = path; ; item = dirname(item)) {
    if (lstatSync(item).isSymbolicLink()) fail();
    if (dirname(item) === item) break;
  }
}
function canonicalAbsolute(path: string): string {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.startsWith("\\\\") ||
    path.includes("\0")
  )
    fail();
  return path;
}
function inside(root: string, path: string): string | null {
  const suffix = relative(root, path);
  return !suffix ||
    (suffix !== ".." &&
      !suffix.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      !isAbsolute(suffix))
    ? suffix
    : null;
}

/** Compare bounded logical rows without opening a writer or acquiring a lease. */
function rows(
  db: DatabaseSync,
  table: string,
  columns: string[],
  order: string,
  expected: Record<string, SqlValue>[]
): void {
  const byteExpression = columns
    .map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`)
    .join("+");
  const size = db
    .prepare(
      `SELECT COUNT(*) AS count,COALESCE(SUM(${byteExpression}),0) AS bytes FROM ${table}`
    )
    .get();
  same(size?.count, expected.length);
  same(
    size?.bytes,
    expected.reduce(
      (sum, row) =>
        sum +
        columns.reduce((total, column) => {
          const value = row[column];
          return (
            total +
            (value === null
              ? 0
              : Buffer.isBuffer(value)
                ? value.length
                : Buffer.byteLength(String(value)))
          );
        }, 0),
      0
    )
  );
  let index = 0;
  for (const actual of db
    .prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${order}`)
    .iterate()) {
    const normalized = Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        value instanceof Uint8Array
          ? Buffer.from(value).toString("base64")
          : value,
      ])
    );
    const wanted = Object.fromEntries(
      Object.entries(expected[index++]).map(([key, value]) => [
        key,
        Buffer.isBuffer(value) ? value.toString("base64") : value,
      ])
    );
    same(normalized, wanted);
  }
  same(index, expected.length);
}
function inspectDatabase(
  path: string,
  tables: string[],
  work: (db: DatabaseSync) => void
): void {
  const before = sha256(regular(path));
  // Immutable reads avoid SQLite's otherwise writable WAL/SHM sidecars. They
  // are safe only for this quarantined, sidecar-free snapshot, never a live DB.
  const uri = pathToFileURL(path);
  uri.searchParams.set("immutable", "1");
  const db = new DatabaseSync(uri.href, { readOnly: true });
  try {
    same(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all()
        .map((row) => row.name),
      [...tables].sort()
    );
    same(
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM sqlite_master WHERE type IN ('view','trigger')"
        )
        .get()?.total,
      0
    );
    same(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    same(db.prepare("PRAGMA foreign_key_check").all(), []);
    work(db);
  } finally {
    db.close();
  }
  same(sha256(regular(path)), before);
}

/** Authenticate and inspect offline staging. This interface never admits effects. */
export function inspectOperatorRecoveryLocations(input: {
  archive: Buffer;
  recoveryKey: Buffer;
  stagingRoot: string;
}): RecoveryLocationContext {
  const checkpoint = decryptOperatorRecovery(
    Buffer.from(input.archive),
    Buffer.from(input.recoveryKey)
  );
  const checkpointSha256 = sha256(canonicalJson(checkpoint));
  const root = resolve(input.stagingRoot);
  noLinks(root);
  same(resolvePrivateCandidateDirectory(root), root);
  const original = {
    operator: canonicalAbsolute(checkpoint.originalOperatorDirectory),
    checkout: canonicalAbsolute(checkpoint.originalCheckout),
  };
  if (
    inside(original.operator, original.checkout) !== null ||
    inside(original.checkout, original.operator) !== null
  )
    fail();
  for (const old of Object.values(original))
    if (inside(old, root) !== null || inside(root, old) !== null) fail();
  const files = new Map(
    checkpoint.files.map((file) => [file.area + "/" + file.path, file])
  );
  const directories = new Set<string>(["operator", "checkout"]);
  const addParents = (path: string) => {
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
      directories.add(parent.replaceAll("\\", "/"));
  };
  for (const file of checkpoint.files)
    if (file.bytes !== null) addParents(file.area + "/" + file.path);
  for (const directory of checkpoint.directories) {
    const path = directory.area + "/" + directory.path;
    directories.add(path);
    addParents(path);
  }
  const infrastructure = new Set([
    "operator/ledger.sqlite",
    "operator/weekly-runs.sqlite",
    "recovery-state.json",
  ]);
  const expectedFiles = new Set([
    ...infrastructure,
    ...checkpoint.files
      .filter((file) => file.bytes !== null)
      .map((file) => file.area + "/" + file.path),
  ]);
  const markerPath = join(root, "recovery-state.json");
  const markerBytes = regular(markerPath, 2 * 1024 * 1024);
  const marker = JSON.parse(markerBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  same(marker.status, "staged");
  same(marker.activationAllowed, false);
  same(marker.version, 1);
  same(marker.checkpointSha256, checkpointSha256);
  same(marker.ledgerRevision, checkpoint.ledgerRevision);
  same(marker.originalOperatorDirectory, original.operator);
  same(marker.originalCheckout, original.checkout);
  same(marker.runtime, checkpoint.runtime);
  function inventory(): void {
    noLinks(root);
    same(
      regular(markerPath, markerBytes.length).toString("base64"),
      markerBytes.toString("base64")
    );
    const seenFiles = new Set<string>(),
      seenDirectories = new Set<string>();
    function walk(directory: string, prefix: string): void {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      for (const name of readdirSync(directory)) {
        const path = prefix ? prefix + "/" + name : name,
          physical = join(root, path);
        const item = lstatSync(physical);
        if (item.isSymbolicLink()) fail();
        if (item.isDirectory()) {
          if (!directories.has(path)) fail();
          seenDirectories.add(path);
          walk(physical, path);
        } else {
          if (!expectedFiles.has(path)) fail();
          const retained = files.get(path),
            bytes = regular(
              physical,
              retained && retained.bytes !== null
                ? Buffer.byteLength(retained.bytes, "base64")
                : maxFileBytes
            );
          if (retained) same(sha256(bytes), retained.sha256);
          seenFiles.add(path);
        }
      }
    }
    walk(root, "");
    same([...seenFiles].sort(), [...expectedFiles].sort());
    same([...seenDirectories].sort(), [...directories].sort());
    for (const file of checkpoint.files)
      if (file.bytes === null && existsSync(join(root, file.area, file.path)))
        fail();
  }
  inventory();
  const databaseHashes = new Map(
    ["ledger.sqlite", "weekly-runs.sqlite"].map((file) => [
      file,
      sha256(regular(join(root, "operator", file))),
    ])
  );
  const ledger = checkpoint.ledger;
  inspectDatabase(
    join(root, "operator/ledger.sqlite"),
    [
      "metadata",
      "artists",
      "venues",
      "events",
      "runs",
      "redirects",
      "event_artists",
      "sources",
    ],
    (db) => {
      same(db.prepare("PRAGMA user_version").get()?.user_version, 1);
      const { events, artists, venues, runs, redirects, ...header } = ledger;
      rows(db, "metadata", ["id", "generation", "digest", "payload"], "id", [
        {
          id: 1,
          generation: 1,
          digest: checkpoint.ledgerRevision,
          payload: canonicalJson(header),
        },
      ]);
      rows(
        db,
        "events",
        ["id", "position", "date", "venue_id", "headliner_id", "payload"],
        "position",
        events.map((event, position) => ({
          id: event.id,
          position,
          date: event.date,
          venue_id: event.venueId,
          headliner_id: event.headlinerArtistId,
          payload: canonicalJson(event),
        }))
      );
      for (const [table, records] of [
        ["artists", artists],
        ["venues", venues],
        ["runs", runs],
      ] as const) {
        rows(
          db,
          table,
          ["id", "position", "payload"],
          "position",
          records.map((record, position) => ({
            id: "id" in record ? record.id : record.runId,
            position,
            payload: canonicalJson(record),
          }))
        );
      }
      rows(
        db,
        "redirects",
        ["position", "payload"],
        "position",
        redirects.map((record, position) => ({
          position,
          payload: canonicalJson(record),
        }))
      );
      rows(
        db,
        "event_artists",
        ["event_id", "position", "artist_id"],
        "event_id,position",
        [...events]
          .sort((a, b) => a.id - b.id)
          .flatMap((event) =>
            event.artistIds.map((artist, position) => ({
              event_id: event.id,
              position,
              artist_id: artist,
            }))
          )
      );
      rows(
        db,
        "sources",
        [
          "event_id",
          "position",
          "kind",
          "source_id",
          "external_id",
          "url",
          "session",
        ],
        "event_id,position",
        [...events]
          .sort((a, b) => a.id - b.id)
          .flatMap((event) =>
            event.sources.map((source, position) => ({
              event_id: event.id,
              position,
              kind: source.kind,
              source_id: source.sourceId,
              external_id: source.externalEventId,
              url: source.canonicalUrl,
              session: source.session,
            }))
          )
      );
    }
  );
  const journal = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(checkpoint.journal, "base64")
  );
  inspectDatabase(
    join(root, "operator/weekly-runs.sqlite"),
    ["ownership", "run_state", "stage_artifact", "intake_evidence"],
    (db) => {
      same(db.prepare("PRAGMA user_version").get()?.user_version, 3);
      same(
        db.prepare("PRAGMA application_id").get()?.application_id,
        1514759762
      );
      rows(
        db,
        "ownership",
        ["scope", "owner", "fence", "expires_at"],
        "scope",
        journal.ownership.map((row) => ({
          scope: row.scope,
          owner: row.owner,
          fence: row.fence,
          expires_at: 0,
        }))
      );
      rows(
        db,
        "run_state",
        ["id", "scope", "revision", "payload"],
        "id",
        journal.runState
      );
      rows(
        db,
        "stage_artifact",
        ["run_id", "stage", "attempt", "identity", "bytes"],
        "run_id,stage,attempt",
        journal.stageArtifacts.map((row) => ({
          run_id: row.runId,
          stage: row.stage,
          attempt: row.attempt,
          identity: row.identity,
          bytes: Buffer.from(row.bytes, "base64"),
        }))
      );
      rows(
        db,
        "intake_evidence",
        ["scope", "kind", "id", "identity", "bytes"],
        "scope,kind,id",
        journal.intakeEvidence.map((row) => ({
          ...row,
          bytes: Buffer.from(row.bytes, "base64"),
        }))
      );
    }
  );
  inventory();
  same(
    compiledEtlDigest(join(root, "checkout"), "worker"),
    checkpoint.runtime.workerSha256
  );
  for (const [file, hash] of databaseHashes)
    same(sha256(regular(join(root, "operator", file))), hash);
  const runtimeRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../.."
  );
  const report: RecoveryLocationReport = {
    status: "inspected",
    activationAllowed: false,
    checkpointSha256,
    ledgerRevision: checkpoint.ledgerRevision,
    fileCount: checkpoint.files.length,
    directoryCount: checkpoint.directories.length,
    runtime: {
      nodeMatches: process.version === checkpoint.runtime.node,
      icuMatches: (process.versions.icu ?? "") === checkpoint.runtime.icu,
      executableMatches:
        sha256(readFileSync(process.execPath)) ===
        checkpoint.runtime.executableSha256,
      workerMatches:
        compiledEtlDigest(runtimeRoot, "worker") ===
        checkpoint.runtime.workerSha256,
      lockfileMatches:
        sha256(regular(join(runtimeRoot, "package-lock.json"))) ===
        checkpoint.runtime.lockfileSha256,
      npmIdentity: checkpoint.files.some(
        (file) =>
          file.area === "operator" &&
          file.bytes !== null &&
          /^weekly-candidates\/.+\/(?:source-build-[^/]+|candidate-[^/]+\/build)\/application-build\.json$/.test(
            file.path
          ) &&
          JSON.parse(Buffer.from(file.bytes, "base64").toString("utf8"))
            .schemaVersion === 2
      )
        ? "retained-build-identities"
        : "not-retained",
    },
    requiredBeforeActivation,
  };
  function revalidate(): void {
    inventory();
    for (const [file, hash] of databaseHashes)
      same(sha256(regular(join(root, "operator", file))), hash);
  }
  function mapPath(path: string): string {
    canonicalAbsolute(path);
    const matches = Object.entries(original).flatMap(([area, base]) => {
      const suffix = inside(base, path);
      return suffix === null
        ? []
        : [area + (suffix ? "/" + suffix.replaceAll("\\", "/") : "")];
    });
    if (matches.length !== 1) fail();
    return matches[0];
  }
  revalidate();
  return {
    get report() {
      return structuredClone(report);
    },
    readOriginalFile(path) {
      revalidate();
      const mapped = mapPath(path),
        retained = files.get(mapped);
      if (!retained || retained.bytes === null) fail();
      const bytes = regular(
        join(root, mapped),
        Buffer.byteLength(retained.bytes, "base64")
      );
      same(sha256(bytes), retained.sha256);
      return bytes;
    },
    resolveOriginalDirectory(field, path) {
      revalidate();
      if (
        ![
          "export.workDirectory",
          "capture.directory",
          "capture.sourceRoot",
        ].includes(field)
      )
        fail();
      const mapped = mapPath(path);
      if (
        !directories.has(mapped) ||
        !mapped.startsWith("operator/weekly-candidates/")
      )
        fail();
      const parts = mapped.split("/");
      if (!parts[2].startsWith("candidate-work-")) fail();
      if (field === "export.workDirectory") {
        if (parts.length !== 3) fail();
      } else {
        if (
          !parts[3]?.startsWith("source-build-") ||
          (field === "capture.directory"
            ? parts.length !== 4
            : parts.length !== 5 || parts[4] !== "source")
        )
          fail();
        const capture = parts.slice(0, 4).join("/"),
          receipt = files.get(capture + "/source-capture.json");
        if (!receipt?.bytes) fail();
        const saved = JSON.parse(
          Buffer.from(receipt.bytes, "base64").toString("utf8")
        ) as { directory?: unknown; sourceRoot?: unknown };
        same(saved.directory, join(original.operator, ...parts.slice(1, 4)));
        same(
          saved.sourceRoot,
          join(original.operator, ...parts.slice(1, 4), "source")
        );
      }
      return join(root, mapped);
    },
  };
}
