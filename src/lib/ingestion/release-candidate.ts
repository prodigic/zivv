import { createHash } from "node:crypto";
import type { IngestionLedger } from "../../types/ingestion.js";
import { validateLedger } from "./ledger.js";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { parseWeeklyEditionLedger } from "./weekly.js";
import { normalizeSiteBase } from "../../utils/site-base.js";
import { localDateKey } from "../discovery.js";
import {
  verifyApplicationBuildReceipt,
  verifyBuildExecutionToolIdentity,
} from "./source-build.js";
import { ETLProcessor } from "../etl/processor.js";
import { DataIndexer, SearchIndexBuilder } from "../etl/indexer.js";
import { capturedExportCatalog, configurationJson } from "./export-catalog.js";
import { buildCapturedEventSlugRedirects } from "./event-slug-redirects.js";
import {
  namesForVerificationStatus,
  type LocalArtistVerificationLedger,
} from "./local-artist-verification.js";
import {
  CANDIDATE_CONFIG_FILES,
  configurationDigest,
  configurationInventory,
  type CandidateConfiguration,
} from "./export-configuration.js";
export {
  CANDIDATE_CONFIG_FILES,
  type CandidateConfiguration,
} from "./export-configuration.js";
export interface CandidateFile {
  path: string;
  size: number;
  sha256: string;
}
export interface ReleaseCandidate {
  schemaVersion: 1;
  candidateId: string;
  sourceCommit: string;
  basePath: string;
  ledgerRevision: string;
  snapshotSha256: string;
  configSha256: string;
  configuration: { path: string; sha256: string | null }[];
  editionId: string;
  cutoffEpochMs: number;
  membershipSha256: string;
  datasetVersion: string;
  manifestSha256: string;
  applicationBuildSha256: string;
  applicationProvenanceSha256: string | null;
  files: CandidateFile[];
}
export interface CandidateInputs {
  sourceCommit: string;
  basePath: string;
  ledger: IngestionLedger;
  snapshot: Buffer;
  recoveryKey: Buffer;
  configuration: CandidateConfiguration;
  editionId: string;
  publicFiles: ReadonlyMap<string, Buffer>;
  applicationBuildManifest: Buffer;
  /** Required by the reviewed build/publish path; legacy isolated seals may omit it. */
  applicationBuildReceipt?: Buffer;
  executionToolIdentity?: Buffer;
}
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const dataFiles = new Set([
  "manifest.json",
  "artists.json",
  "venues.json",
  "indexes.json",
  "recent-additions.json",
  "search-documents.json",
  "search-terms.json",
  "local-artists.json",
  "local-artist-exclude.json",
]);
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid candidate object");
  return value as Record<string, unknown>;
}
function parse(bytes: Buffer): Record<string, unknown> {
  return object(JSON.parse(bytes.toString("utf8")));
}
function required(files: ReadonlyMap<string, Buffer>, path: string): Buffer {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`Missing candidate file: ${path}`);
  return bytes;
}
function allowed(path: string): boolean {
  if (
    [
      "index.html",
      "404.html",
      "manifest.json",
      "vite.svg",
      ".nojekyll",
    ].includes(path)
  )
    return true;
  if (
    /^assets\/[A-Za-z0-9_-]+\.(?:js|css|png|jpg|jpeg|webp|svg|woff2)$/.test(
      path
    )
  )
    return true;
  return (
    path.startsWith("data/") &&
    (dataFiles.has(path.slice(5)) ||
      /^data\/events-\d{4}-(?:0[1-9]|1[0-2])\.json$/.test(path))
  );
}
function same(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error(`Candidate mismatch: ${label}`);
}

function verifyRecords(actual: unknown[], expected: readonly unknown[]): void {
  const expectedById = new Map(expected.map((item) => [object(item).id, item]));
  const seen = new Set<unknown>();
  for (const item of actual) {
    const id = object(item).id;
    if (seen.has(id) || !expectedById.has(id))
      throw new Error("Invalid exported entity identity");
    seen.add(id);
    same(item, expectedById.get(id), "canonical identity/history/metadata");
  }
  if (seen.size !== expectedById.size)
    throw new Error("Export omitted canonical entities");
}

/** Validate exact supplied bytes against authenticated recovery and captured edition/config. */
export function sealReleaseCandidate(input: CandidateInputs): ReleaseCandidate {
  if (input.executionToolIdentity && !input.applicationBuildReceipt)
    throw new Error("Execution tool identity lacks build provenance");
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit))
    throw new Error("Invalid source commit");
  const basePath = normalizeSiteBase(input.basePath);
  validateLedger(input.ledger);
  const ledgerRevision = ledgerDigest(input.ledger);
  same(
    ledgerDigest(decryptLedgerSnapshot(input.snapshot, input.recoveryKey)),
    ledgerRevision,
    "recovery revision"
  );
  const configuration = configurationInventory(input.configuration);
  const weeklyBytes = input.configuration["ingestion/weekly-editions.json"];
  if (!weeklyBytes) throw new Error("Missing frozen edition configuration");
  const weekly = parseWeeklyEditionLedger(
    JSON.parse(weeklyBytes.toString("utf8"))
  );
  const edition = weekly.editions.find(
    (item) => item.editionId === input.editionId
  );
  if (!edition) throw new Error("Frozen edition not found");
  const latest = [...weekly.editions].sort(
    (a, b) => b.endEpochMs - a.endEpochMs
  )[0];
  same(latest.editionId, edition.editionId, "exported edition selection");
  const eventIds = new Set(
    input.ledger.events.map((event) => Number(event.id))
  );
  if (edition.eventIds.some((id) => !eventIds.has(Number(id))))
    throw new Error("Frozen edition references absent events");
  const portablePaths = new Set<string>();
  const files = [...input.publicFiles]
    .map(([path, bytes]) => {
      if (!allowed(path))
        throw new Error(`Forbidden publication artifact: ${path}`);
      const portable = path.toLowerCase();
      if (portablePaths.has(portable))
        throw new Error("Case-insensitive publication path collision");
      portablePaths.add(portable);
      return { path, size: bytes.length, sha256: hash(bytes) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const path of dataFiles) required(input.publicFiles, "data/" + path);
  const manifestBytes = required(input.publicFiles, "data/manifest.json");
  const manifest = parse(manifestBytes);
  same(manifest.sourceLedgerRevision, ledgerRevision, "export ledger revision");
  same(
    manifest.sourceConfigurationSha256,
    configurationDigest(input.configuration),
    "export configuration"
  );
  if (
    typeof manifest.datasetVersion !== "string" ||
    !manifest.datasetVersion.trim()
  )
    throw new Error("Invalid dataset version");
  same(manifest.totalEvents, input.ledger.events.length, "event count");
  same(manifest.totalArtists, input.ledger.artists.length, "artist count");
  same(manifest.totalVenues, input.ledger.venues.length, "venue count");
  same(
    manifest.weeklyEdition,
    {
      editionId: edition.editionId,
      startEpochMs: edition.startEpochMs,
      endEpochMs: edition.endEpochMs,
      eventIds: edition.eventIds.map(Number),
      datasetVersion: edition.datasetVersion,
    },
    "frozen edition"
  );
  const chunks = object(manifest.chunks);
  if (!Array.isArray(chunks.events)) throw new Error("Missing event chunks");
  for (const [kind, filename] of Object.entries({
    artists: "artists.json",
    venues: "venues.json",
    indexes: "indexes.json",
    recentAdditions: "recent-additions.json",
  }))
    same(object(chunks[kind]).filename, filename, "chunk role");
  for (const chunk of chunks.events)
    if (
      !/^events-\d{4}-(?:0[1-9]|1[0-2])\.json$/.test(
        String(object(chunk).filename)
      )
    )
      throw new Error("Invalid event chunk role");
  const chunkFiles = new Set<string>();
  for (const item of [
    ...chunks.events,
    chunks.artists,
    chunks.venues,
    chunks.indexes,
    chunks.recentAdditions,
  ]) {
    const chunk = object(item);
    if (
      typeof chunk.filename !== "string" ||
      !/^[a-z0-9-]+\.json$/.test(chunk.filename) ||
      chunkFiles.has(chunk.filename)
    )
      throw new Error("Invalid or repeated chunk filename");
    chunkFiles.add(chunk.filename);
    const bytes = required(input.publicFiles, "data/" + chunk.filename);
    same(chunk.size, bytes.length, "chunk size");
    same(chunk.checksum, "sha256-" + hash(bytes), "chunk checksum");
  }
  for (const file of files)
    if (
      file.path.startsWith("data/events-") &&
      !chunkFiles.has(file.path.slice(5))
    )
      throw new Error("Unlisted event chunk");
  const exportedEvents: unknown[] = [];
  for (const item of chunks.events) {
    const filename = String(object(item).filename);
    const chunk = parse(required(input.publicFiles, "data/" + filename));
    same(chunk.chunkId, filename.slice(7, -5), "month identity");
    if (!Array.isArray(chunk.events))
      throw new Error("Invalid event chunk records");
    same(object(item).chunkId, chunk.chunkId, "manifest month identity");
    same(object(item).eventCount, chunk.events.length, "chunk event count");
    const dates = chunk.events.map((event) => object(event).dateEpochMs);
    if (
      !dates.length ||
      dates.some(
        (value) => typeof value !== "number" || !Number.isSafeInteger(value)
      )
    )
      throw new Error("Invalid chunk dates");
    const range = {
      startEpochMs: Math.min(...(dates as number[])),
      endEpochMs: Math.max(...(dates as number[])),
    };
    same(chunk.dateRange, range, "chunk date range");
    same(object(item).dateRange, range, "manifest date range");
    for (const event of chunk.events)
      if (String(object(event).date).slice(0, 7) !== chunk.chunkId)
        throw new Error("Event in wrong month");
    exportedEvents.push(...chunk.events);
  }
  if (
    typeof manifest.processedAt !== "number" ||
    !Number.isSafeInteger(manifest.processedAt) ||
    manifest.processedAt < 0
  )
    throw new Error("Invalid export observation");
  same(
    manifest.datasetVersion,
    new Date(manifest.processedAt).toISOString(),
    "dataset observation"
  );
  same(manifest.lastUpdated, manifest.processedAt, "export timestamp");
  same(manifest.schemaVersion, "2.0.0", "manifest schema");
  const allDates = input.ledger.events.map((event) => event.dateEpochMs);
  const first = allDates.length ? Math.min(...allDates) : manifest.processedAt;
  const last = allDates.length ? Math.max(...allDates) : manifest.processedAt;
  same(
    manifest.dateRange,
    {
      startEpochMs: first,
      endEpochMs: last,
      startDate: new Date(first).toISOString().slice(0, 10),
      endDate: new Date(last).toISOString().slice(0, 10),
    },
    "dataset date range"
  );
  same(
    manifest.latestIngestionDate,
    localDateKey(
      Math.max(
        0,
        ...input.ledger.events.map((event) => event.createdAtEpochMs || 0)
      ),
      "America/Los_Angeles"
    ) ?? new Date(manifest.processedAt).toISOString().slice(0, 10),
    "latest ingestion date"
  );
  const expected = capturedExportCatalog(input.ledger, input.configuration);
  ETLProcessor.populateExportSummaries(
    expected.events,
    expected.artists,
    expected.venues,
    manifest.processedAt
  );
  verifyRecords(exportedEvents, expected.events);
  for (const [filename, entities] of [
    ["artists.json", expected.artists],
    ["venues.json", expected.venues],
  ] as const) {
    const records: unknown = JSON.parse(
      required(input.publicFiles, "data/" + filename).toString("utf8")
    );
    if (!Array.isArray(records)) throw new Error("Invalid entity records");
    verifyRecords(records, entities);
  }
  const indexes = DataIndexer.buildIndexes(
    expected.events,
    expected.artists,
    expected.venues,
    manifest.processedAt
  );
  indexes.eventSlugRedirects = buildCapturedEventSlugRedirects(
    configurationJson(input.configuration, "event-slug-redirects.json") ?? [],
    expected.events
  );
  const search = SearchIndexBuilder.buildSearchIndex(
    expected.events,
    expected.artists,
    expected.venues
  );
  const verification = (configurationJson(
    input.configuration,
    "local-artist-verification.json"
  ) ?? { schemaVersion: 1, entries: [] }) as LocalArtistVerificationLedger;
  for (const [filename, value] of [
    ["indexes.json", indexes],
    ["search-documents.json", search.documents],
    ["search-terms.json", search.terms],
    [
      "local-artists.json",
      namesForVerificationStatus(verification, "local", expected.artists),
    ],
    [
      "local-artist-exclude.json",
      namesForVerificationStatus(verification, "non-local", expected.artists),
    ],
    [
      "recent-additions.json",
      {
        schemaVersion: 1,
        datasetVersion: manifest.datasetVersion,
        events: input.ledger.events.map((event) => ({
          eventId: event.id,
          chunkId: event.date.slice(0, 7),
          createdAtEpochMs: event.createdAtEpochMs,
          addedDateProvenance: event.addedDateProvenance,
          firstImportedBy: event.firstImportedBy,
          sourceKinds: [...new Set(event.sources.map((source) => source.kind))],
        })),
      },
    ],
  ])
    same(
      JSON.parse(
        required(input.publicFiles, "data/" + filename).toString("utf8")
      ),
      value,
      "derived output " + filename
    );
  const webManifest = parse(required(input.publicFiles, "manifest.json"));
  same(webManifest.scope, basePath, "web manifest scope");
  same(webManifest.start_url, basePath, "web manifest start URL");
  const build = parse(input.applicationBuildManifest);
  const buildAssets = new Set<string>();
  let hasEntry = false;
  for (const value of Object.values(build)) {
    const entry = object(value);
    if (entry.isEntry === true) hasEntry = true;
    if (typeof entry.file !== "string") throw new Error("Invalid build entry");
    for (const field of ["imports", "dynamicImports"]) {
      const references = entry[field] ?? [];
      if (
        !Array.isArray(references) ||
        references.some(
          (ref) => typeof ref !== "string" || !Object.hasOwn(build, ref)
        )
      )
        throw new Error("Missing build import entry");
    }
    for (const field of ["css", "assets"])
      if (entry[field] !== undefined && !Array.isArray(entry[field]))
        throw new Error("Invalid build assets");
    for (const path of [
      entry.file,
      ...((entry.css as unknown[]) ?? []),
      ...((entry.assets as unknown[]) ?? []),
    ]) {
      if (
        typeof path !== "string" ||
        !path.startsWith("assets/") ||
        !allowed(path)
      )
        throw new Error("Invalid build asset path");
      required(input.publicFiles, path);
      buildAssets.add(path);
    }
  }
  if (!hasEntry) throw new Error("Build manifest lacks application entry");
  const main = object(build["index.html"]);
  if (main.isEntry !== true || typeof main.file !== "string")
    throw new Error("Missing SPA build entry");
  const scriptSources = [
    ...required(input.publicFiles, "index.html")
      .toString("utf8")
      .matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g),
  ].map((match) => match[1]);
  if (!scriptSources.includes(basePath + main.file))
    throw new Error("HTML omits compiled SPA entry");
  for (const file of files)
    if (file.path.startsWith("assets/") && !buildAssets.has(file.path))
      throw new Error("Unlisted or stale build asset");
  if (webManifest.icons !== undefined) {
    if (!Array.isArray(webManifest.icons))
      throw new Error("Invalid web manifest icons");
    for (const icon of webManifest.icons) {
      const source = object(icon).src;
      if (typeof source !== "string" || !source.startsWith(basePath))
        throw new Error("Manifest icon outside candidate base");
      required(input.publicFiles, source.slice(basePath.length));
    }
  }
  for (const name of ["index.html", "404.html"]) {
    const html = required(input.publicFiles, name).toString("utf8");
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const reference = match[1];
      if (!reference.startsWith(basePath))
        throw new Error("HTML asset outside candidate base");
      required(input.publicFiles, reference.slice(basePath.length));
    }
    if (html.includes("src/main.tsx"))
      throw new Error("Uncompiled application entry");
  }
  if (input.applicationBuildReceipt) {
    const build = verifyApplicationBuildReceipt(input.applicationBuildReceipt, {
      sourceCommit: input.sourceCommit,
      basePath,
      applicationBuildManifest: input.applicationBuildManifest,
      applicationFiles: new Map(
        [...input.publicFiles].filter(([path]) => !path.startsWith("data/"))
      ),
    });
    verifyBuildExecutionToolIdentity(build, input.executionToolIdentity);
  }
  const identity = {
    schemaVersion: 1 as const,
    sourceCommit: input.sourceCommit,
    basePath,
    ledgerRevision,
    snapshotSha256: hash(input.snapshot),
    configSha256: hash(canonicalJson(configuration)),
    configuration,
    editionId: edition.editionId,
    cutoffEpochMs: edition.endEpochMs,
    membershipSha256: hash(canonicalJson(edition.eventIds)),
    datasetVersion: manifest.datasetVersion,
    manifestSha256: hash(manifestBytes),
    applicationBuildSha256: hash(input.applicationBuildManifest),
    applicationProvenanceSha256: input.applicationBuildReceipt
      ? hash(input.applicationBuildReceipt)
      : null,
    files,
  };
  return { ...identity, candidateId: hash(canonicalJson(identity)) };
}

/** Recheck bytes before promotion; changed, missing or added artifacts invalidate prior checks. */
export function verifySealedCandidate(
  candidate: ReleaseCandidate,
  input: CandidateInputs
): void {
  same(sealReleaseCandidate(input), candidate, "sealed candidate identity");
}

/** Parse public identity without private inputs; callers must supply a trusted ID separately. */
export function parseReleaseCandidate(bytes: Buffer): ReleaseCandidate {
  const value = parse(bytes);
  const keys = [
    "schemaVersion",
    "candidateId",
    "sourceCommit",
    "basePath",
    "ledgerRevision",
    "snapshotSha256",
    "configSha256",
    "configuration",
    "editionId",
    "cutoffEpochMs",
    "membershipSha256",
    "datasetVersion",
    "manifestSha256",
    "applicationBuildSha256",
    "applicationProvenanceSha256",
    "files",
  ];
  same(Object.keys(value).sort(), keys.sort(), "public identity fields");
  if (
    value.schemaVersion !== 1 ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    typeof value.basePath !== "string" ||
    normalizeSiteBase(value.basePath) !== value.basePath
  )
    throw new Error("Invalid candidate schema/source/base");
  for (const name of [
    "candidateId",
    "ledgerRevision",
    "snapshotSha256",
    "configSha256",
    "membershipSha256",
    "manifestSha256",
    "applicationBuildSha256",
  ])
    if (
      typeof value[name] !== "string" ||
      !/^[a-f0-9]{64}$/.test(value[name] as string)
    )
      throw new Error("Invalid candidate digest");
  if (
    value.applicationProvenanceSha256 !== null &&
    (typeof value.applicationProvenanceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.applicationProvenanceSha256))
  )
    throw new Error("Invalid candidate provenance digest");
  for (const name of ["editionId", "datasetVersion"])
    if (
      typeof value[name] !== "string" ||
      !(value[name] as string).trim() ||
      [...(value[name] as string)].some(
        (character) => character.charCodeAt(0) < 32
      )
    )
      throw new Error("Invalid candidate edition/version");
  if (
    !Number.isSafeInteger(value.cutoffEpochMs) ||
    (value.cutoffEpochMs as number) < 0
  )
    throw new Error("Invalid candidate cutoff");
  if (
    !Array.isArray(value.configuration) ||
    value.configuration.length !== CANDIDATE_CONFIG_FILES.length
  )
    throw new Error("Invalid candidate configuration inventory");
  value.configuration.forEach((item, index) => {
    const record = object(item);
    same(
      Object.keys(record).sort(),
      ["path", "sha256"],
      "configuration fields"
    );
    if (
      record.path !== CANDIDATE_CONFIG_FILES[index] ||
      (record.sha256 !== null &&
        (typeof record.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(record.sha256)))
    )
      throw new Error("Invalid candidate configuration entry");
  });
  same(
    hash(canonicalJson(value.configuration)),
    value.configSha256,
    "configuration digest"
  );
  if (!Array.isArray(value.files) || value.files.length === 0)
    throw new Error("Invalid candidate public inventory");
  let previous = "";
  for (const item of value.files) {
    const file = object(item);
    same(
      Object.keys(file).sort(),
      ["path", "sha256", "size"],
      "public file fields"
    );
    if (
      typeof file.path !== "string" ||
      !allowed(file.path) ||
      file.path <= previous ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid candidate public file");
    previous = file.path;
  }
  const { candidateId, ...identity } = value;
  same(hash(canonicalJson(identity)), candidateId, "public candidate identity");
  return value as unknown as ReleaseCandidate;
}
