import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { migrateExistingCatalog } from "../../lib/ingestion/migrate.js";
import { ETLProcessor } from "../../lib/etl/processor.js";
import { loadLedger } from "../../lib/ingestion/ledger.js";
import { encryptLedgerSnapshot } from "../../lib/ingestion/encrypted-backup.js";
import {
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyLedger,
} from "../../lib/ingestion/weekly.js";
import {
  CANDIDATE_CONFIG_FILES,
  sealReleaseCandidate,
  verifySealedCandidate,
  type CandidateInputs,
} from "../../lib/ingestion/release-candidate.js";
import {
  buildCandidateBundle,
  readVerifiedCandidateBundle,
} from "../../lib/ingestion/candidate-bundle.js";
import type {
  Artist,
  ArtistId,
  Event,
  EventId,
  Venue,
  VenueId,
} from "../../types/events.js";
import type { DataManifest, RecentAdditionsIndex } from "../../types/data.js";

const directories: string[] = [];
const cutoff = Date.parse("2026-10-09T19:00:00Z");
const created = cutoff - 1;
const key = Buffer.alloc(32, 7);
type InputMutation = (input: CandidateInputs) => CandidateInputs;
type FileMutation = (files: Map<string, Buffer>) => unknown;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-release-candidate-"));
  directories.push(root);
  const event: Event = {
    id: 101 as EventId,
    slug: "2026-12-01-test-band-test-hall",
    date: "2026-12-01",
    dateEpochMs: Date.parse("2026-12-01T12:00:00Z"),
    startTimeEpochMs: Date.parse("2026-12-01T20:00:00Z"),
    timezone: "America/Los_Angeles",
    headlinerArtistId: 201 as ArtistId,
    artistIds: [201 as ArtistId],
    venueId: 301 as VenueId,
    isFree: false,
    priceMin: 20,
    ageRestriction: "21+",
    status: "confirmed",
    tags: [],
    venueType: "club",
    createdAtEpochMs: created,
    updatedAtEpochMs: created,
    sourceLineNumber: 1,
  };
  const artist: Artist = {
    id: 201 as ArtistId,
    name: "Test Band",
    normalizedName: "test",
    slug: "test-band",
    aliases: [],
    upcomingEventCount: 1,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: created,
    updatedAtEpochMs: created,
  };
  const venue: Venue = {
    id: 301 as VenueId,
    name: "Test Hall",
    normalizedName: "test hall",
    slug: "test-hall",
    city: "S.f",
    address: "1 Mission Street",
    ageRestriction: "21+",
    upcomingEventCount: 1,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: created,
    updatedAtEpochMs: created,
    sourceLineNumber: 1,
  };
  mkdirSync(join(root, "public/data"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  const writeJson = (path: string, value: unknown) =>
    writeFileSync(join(root, path), JSON.stringify(value));
  writeJson(join("public", "data", "events-2026-12.json"), {
    chunkId: "2026-12",
    events: [event],
  });
  writeJson(join("public", "data", "artists.json"), [artist]);
  writeJson(join("public", "data", "venues.json"), [venue]);
  writeJson(join("public", "data", "manifest.json"), {
    datasetVersion: "old",
    schemaVersion: "1.0.0",
    totalEvents: 1,
    totalArtists: 1,
    totalVenues: 1,
  });
  writeJson(join("data", "venue-sources.json"), { sources: [] });
  writeFileSync(
    join(root, "data/events.txt"),
    "dec 1 2026 Test Band at Test Hall, S.F. 8pm\n"
  );
  writeFileSync(
    join(root, "data/venues.txt"),
    "Test Hall, 1 Mission Street, S.F.\n"
  );
  return { root, event, artist, venue };
}

async function inputs(): Promise<{ root: string; input: CandidateInputs }> {
  const { root } = fixture();
  await migrateExistingCatalog(root, created);
  const ledgerPath = join(root, "data/ingestion/ledger.json");
  const beforeWeekly = await loadLedger(ledgerPath);
  const weekly = prepareWeeklyEdition(
    createEmptyWeeklyEditionLedger(),
    beforeWeekly.events.map(
      ({ id, createdAtEpochMs, addedDateProvenance }) => ({
        id,
        createdAtEpochMs,
        addedDateProvenance,
      })
    ),
    { editionId: "week-2026-10-09", cutoff, datasetVersion: "fixture-dataset" }
  );
  const weeklyBytes = Buffer.from(serializeWeeklyLedger(weekly.ledger));
  writeFileSync(join(root, "data/ingestion/weekly-editions.json"), weeklyBytes);
  expect((await new ETLProcessor(root).processData()).success).toBe(true);

  const publicFiles = new Map<string, Buffer>();
  const readTree = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      const relative = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) readTree(path, relative);
      else publicFiles.set(relative, readFileSync(path));
    }
  };
  writeFileSync(
    join(root, "public/index.html"),
    '<script src="/zivv/assets/app.js"></script>'
  );
  writeFileSync(
    join(root, "public/404.html"),
    '<link href="/zivv/assets/app.css" rel="stylesheet">'
  );
  writeFileSync(join(root, "public/vite.svg"), "svg");
  writeFileSync(
    join(root, "public/manifest.json"),
    JSON.stringify({ scope: "/zivv/", start_url: "/zivv/" })
  );
  mkdirSync(join(root, "public/assets"), { recursive: true });
  writeFileSync(join(root, "public/assets/app.js"), "compiled");
  writeFileSync(join(root, "public/assets/app.css"), "compiled");
  writeFileSync(join(root, "public/assets/lazy.js"), "lazy compiled");
  readTree(join(root, "public"));

  const configuration = Object.fromEntries(
    CANDIDATE_CONFIG_FILES.map((path) => {
      const absolute = join(root, "data", path);
      return [path, existsSync(absolute) ? readFileSync(absolute) : null];
    })
  ) as CandidateInputs["configuration"];
  const snapshot = encryptLedgerSnapshot(beforeWeekly, key);
  return {
    root,
    input: {
      sourceCommit: "a".repeat(40),
      basePath: "/zivv/",
      ledger: beforeWeekly,
      snapshot,
      recoveryKey: Buffer.from(key),
      configuration,
      editionId: "week-2026-10-09",
      publicFiles,
      applicationBuildManifest: Buffer.from(
        JSON.stringify({
          "index.html": {
            file: "assets/app.js",
            isEntry: true,
            css: ["assets/app.css"],
            dynamicImports: ["lazy.ts"],
          },
          "lazy.ts": { file: "assets/lazy.js" },
        })
      ),
    },
  };
}

function replaceDataFile(
  input: CandidateInputs,
  filename: string,
  value: unknown
): CandidateInputs {
  const bytes = Buffer.from(JSON.stringify(value));
  const publicFiles = new Map(input.publicFiles).set(`data/${filename}`, bytes);
  const manifest: DataManifest = JSON.parse(
    publicFiles.get("data/manifest.json")!.toString("utf8")
  );
  const descriptors = [
    ...manifest.chunks.events,
    manifest.chunks.artists,
    manifest.chunks.venues,
    manifest.chunks.indexes,
    manifest.chunks.recentAdditions,
  ];
  const descriptor = descriptors.find((item) => item?.filename === filename);
  if (!descriptor) throw new Error(`Fixture descriptor missing: ${filename}`);
  descriptor.size = bytes.length;
  descriptor.checksum = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  publicFiles.set("data/manifest.json", Buffer.from(JSON.stringify(manifest)));
  return { ...input, publicFiles };
}

function bundleInput(root: string, input: CandidateInputs) {
  return {
    privateDirectory: join(root, "private-bundles"),
    sourceCommit: input.sourceCommit,
    basePath: input.basePath,
    editionId: input.editionId,
    ledger: input.ledger,
    snapshot: input.snapshot,
    recoveryKey: input.recoveryKey,
    configuration: input.configuration,
    applicationBuildManifest: input.applicationBuildManifest,
    applicationFiles: new Map(
      [...input.publicFiles].filter(([path]) => !path.startsWith("data/"))
    ),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      !resolve(directory).startsWith(
        resolve(tmpdir(), "zivv-release-candidate-")
      )
    )
      throw new Error("Unsafe test cleanup path");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release candidate sealing", () => {
  it("rejects case-folded file collisions before Windows materialization", async () => {
    const { input } = await inputs();
    const manifest: Record<string, unknown> = JSON.parse(
      input.applicationBuildManifest.toString("utf8")
    );
    manifest["uppercase.ts"] = { file: "assets/APP.js" };
    expect(() =>
      sealReleaseCandidate({
        ...input,
        applicationBuildManifest: Buffer.from(JSON.stringify(manifest)),
        publicFiles: new Map(input.publicFiles).set(
          "assets/APP.js",
          Buffer.from("different module")
        ),
      })
    ).toThrow("Case-insensitive publication path collision");
  });
  it("seals an isolated ETL export and keeps map order out of identity", async () => {
    const { input } = await inputs();
    const candidate = sealReleaseCandidate(input);
    const reversed = new Map([...input.publicFiles].reverse());
    expect(sealReleaseCandidate({ ...input, publicFiles: reversed })).toEqual(
      candidate
    );
    expect(candidate.files.map((file) => file.path)).toEqual(
      [...candidate.files].map((file) => file.path).sort()
    );
  });

  it("preserves candidate identity when verification occurs after the show date", async () => {
    const { input } = await inputs();
    const candidate = sealReleaseCandidate(input);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2027-01-01T20:00:00Z"));
    try {
      expect(sealReleaseCandidate(input)).toEqual(candidate);
      expect(() => verifySealedCandidate(candidate, input)).not.toThrow();
    } finally {
      clock.mockRestore();
    }
  });

  it.each<[string, InputMutation]>([
    [
      "old snapshot",
      (input: CandidateInputs) => {
        const oldLedger = structuredClone(input.ledger);
        oldLedger.events[0].priceMin = 19;
        return { ...input, snapshot: encryptLedgerSnapshot(oldLedger, key) };
      },
    ],
    [
      "wrong key",
      (input: CandidateInputs) => ({
        ...input,
        recoveryKey: Buffer.alloc(32, 8),
      }),
    ],
    [
      "corrupt snapshot",
      (input: CandidateInputs) => ({
        ...input,
        snapshot: Buffer.from("corrupt"),
      }),
    ],
  ])("rejects %s", async (_label: string, mutate: InputMutation) => {
    const { input } = await inputs();
    const candidate = sealReleaseCandidate(input);
    expect(() => verifySealedCandidate(candidate, mutate(input))).toThrow();
  });

  it("rejects changed configuration before sealing", async () => {
    const { input } = await inputs();
    const changed = {
      ...input,
      configuration: {
        ...input.configuration,
        "events.txt": Buffer.from("changed"),
      },
    };
    expect(() => sealReleaseCandidate(changed)).toThrow(/export configuration/);
  });

  it.each<[string, FileMutation]>([
    [
      "changed byte",
      (files: Map<string, Buffer>) =>
        files.set("index.html", Buffer.from("changed")),
    ],
    ["missing byte", (files: Map<string, Buffer>) => files.delete("404.html")],
    [
      "added byte",
      (files: Map<string, Buffer>) =>
        files.set("assets/extra.js", Buffer.from("extra")),
    ],
  ])(
    "rejects a %s in the published map",
    async (_label: string, mutate: FileMutation) => {
      const { input } = await inputs();
      const candidate = sealReleaseCandidate(input);
      const files = new Map(input.publicFiles);
      mutate(files);
      expect(() =>
        verifySealedCandidate(candidate, { ...input, publicFiles: files })
      ).toThrow();
    }
  );

  it.each<[string, InputMutation]>([
    [
      "missing config inventory",
      (input: CandidateInputs) => {
        const configuration: Partial<CandidateInputs["configuration"]> = {
          ...input.configuration,
        };
        delete configuration["events.txt"];
        // Exercise malformed external input beyond the required-key type boundary.
        return { ...input, configuration } as unknown as CandidateInputs;
      },
    ],
    [
      "different frozen edition",
      (input: CandidateInputs) => ({ ...input, editionId: "missing-edition" }),
    ],
    [
      "different config bytes",
      (input: CandidateInputs) => ({
        ...input,
        configuration: {
          ...input.configuration,
          "events.txt": Buffer.from("changed"),
        },
      }),
    ],
  ])("rejects %s", async (_label: string, mutate: InputMutation) => {
    const { input } = await inputs();
    const candidate = sealReleaseCandidate(input);
    expect(() => verifySealedCandidate(candidate, mutate(input))).toThrow();
  });

  it.each([
    "data/events-2027-01.json",
    "raw/source.txt",
    "private.key",
    "data/ledger.sqlite",
    "CNAME",
  ])("rejects forbidden or unlisted artifact %s", async (path: string) => {
    const { input } = await inputs();
    expect(() =>
      sealReleaseCandidate({
        ...input,
        publicFiles: new Map(input.publicFiles).set(path, Buffer.from("x")),
      })
    ).toThrow();
  });

  it.each<[string, Partial<Venue>]>([
    ["address", { address: "999 Forged Avenue" }],
    ["website", { website: "https://forged.example/" }],
    [
      "map location",
      {
        mapLocation: {
          latitude: 0,
          longitude: 0,
          precision: "address",
          sourceUrl: "https://forged.example/map",
        },
      },
    ],
    ["computed summary", { totalEventCount: 999 }],
  ])(
    "rejects forged venue %s even with matching chunk checksums",
    async (_label: string, forged: Partial<Venue>) => {
      const { input } = await inputs();
      const venues: Venue[] = JSON.parse(
        input.publicFiles.get("data/venues.json")!.toString("utf8")
      );
      Object.assign(venues[0], forged);
      const changed = replaceDataFile(input, "venues.json", venues);
      expect(() => sealReleaseCandidate(changed)).toThrow(/metadata/);
    }
  );

  it.each<[string, (index: RecentAdditionsIndex) => void]>([
    [
      "membership",
      (index: RecentAdditionsIndex) => {
        index.events = [];
      },
    ],
    [
      "added date",
      (index: RecentAdditionsIndex) => {
        index.events[0].createdAtEpochMs += 1;
      },
    ],
    [
      "month",
      (index: RecentAdditionsIndex) => {
        index.events[0].chunkId = "2027-01";
      },
    ],
    [
      "dataset version",
      (index: RecentAdditionsIndex) => {
        index.datasetVersion = "forged";
      },
    ],
  ])(
    "rejects incorrect recent-additions %s with matching checksums",
    async (_label: string, mutate: (index: RecentAdditionsIndex) => void) => {
      const { input } = await inputs();
      const recent: RecentAdditionsIndex = JSON.parse(
        input.publicFiles.get("data/recent-additions.json")!.toString("utf8")
      );
      mutate(recent);
      expect(() =>
        sealReleaseCandidate(
          replaceDataFile(input, "recent-additions.json", recent)
        )
      ).toThrow(/derived output recent-additions/);
    }
  );

  it("rejects manifest month identity inconsistent with its event chunk", async () => {
    const { input } = await inputs();
    const manifest: DataManifest = JSON.parse(
      input.publicFiles.get("data/manifest.json")!.toString("utf8")
    );
    manifest.chunks.events[0].chunkId = "2027-01";
    const publicFiles = new Map(input.publicFiles).set(
      "data/manifest.json",
      Buffer.from(JSON.stringify(manifest))
    );
    expect(() => sealReleaseCandidate({ ...input, publicFiles })).toThrow(
      /manifest month identity/
    );
  });

  it.each<[string, FileMutation]>([
    [
      "missing lazy JavaScript",
      (files: Map<string, Buffer>) => files.delete("assets/lazy.js"),
    ],
    [
      "extra stale JavaScript",
      (files: Map<string, Buffer>) =>
        files.set("assets/old.js", Buffer.from("old build")),
    ],
  ])(
    "rejects %s against the captured application build manifest",
    async (_label: string, mutate: FileMutation) => {
      const { input } = await inputs();
      const publicFiles = new Map(input.publicFiles);
      mutate(publicFiles);
      expect(() => sealReleaseCandidate({ ...input, publicFiles })).toThrow(
        /Missing candidate file: assets\/lazy.js|Unlisted or stale build asset/
      );
    }
  );
});

describe("private candidate bundles", () => {
  it("captures caller-owned inputs before yielding and verifies the saved bytes", async () => {
    const { root, input } = await inputs();
    const buildInput = bundleInput(root, input);
    const expectedSnapshot = Buffer.from(input.snapshot);
    const expectedApp = Buffer.from(
      buildInput.applicationFiles.get("assets/app.js")!
    );
    const expectedConfiguration = Buffer.from(
      input.configuration["events.txt"]!
    );
    const expectedBuildManifest = Buffer.from(input.applicationBuildManifest);
    const pending = buildCandidateBundle(buildInput);

    input.ledger.events[0].priceMin = 999;
    input.snapshot.fill(0);
    input.recoveryKey.fill(0);
    input.configuration["events.txt"]!.fill(0);
    buildInput.applicationFiles.get("assets/app.js")!.fill(0);
    input.applicationBuildManifest.fill(0);

    const built = await pending;
    const verified = await readVerifiedCandidateBundle(
      built.directory,
      key,
      built.candidate.candidateId
    );
    expect(verified.candidate).toEqual(built.candidate);
    expect(verified.snapshot).toEqual(expectedSnapshot);
    expect(verified.publicFiles.get("assets/app.js")).toEqual(expectedApp);
    expect(
      readFileSync(join(built.directory, "workspace/data/events.txt"))
    ).toEqual(expectedConfiguration);
    expect(
      readFileSync(join(built.directory, "build/vite-manifest.json"))
    ).toEqual(expectedBuildManifest);
    const exportedEvents: { events: Event[] } = JSON.parse(
      verified.publicFiles.get("data/events-2026-12.json")!.toString("utf8")
    );
    expect(exportedEvents.events[0].priceMin).toBe(20);

    await expect(
      readVerifiedCandidateBundle(built.directory, key, "f".repeat(64))
    ).rejects.toThrow(/candidate|identity/i);

    const appPath = join(built.directory, "workspace/public/assets/app.js");
    writeFileSync(appPath, "tampered app");
    await expect(
      readVerifiedCandidateBundle(
        built.directory,
        key,
        built.candidate.candidateId
      )
    ).rejects.toThrow();
    writeFileSync(appPath, expectedApp);
    writeFileSync(
      join(built.directory, "complete.json"),
      JSON.stringify({
        schemaVersion: 1,
        candidateId: "forged",
      })
    );
    await expect(
      readVerifiedCandidateBundle(
        built.directory,
        key,
        built.candidate.candidateId
      )
    ).rejects.toThrow(/marker|incomplete/);
    rmSync(join(built.directory, "complete.json"));
    await expect(
      readVerifiedCandidateBundle(
        built.directory,
        key,
        built.candidate.candidateId
      )
    ).rejects.toThrow();
  });

  it("refuses bundle output inside a Git repository before creating it", async () => {
    const { root, input } = await inputs();
    mkdirSync(join(root, ".git"));
    const buildInput = bundleInput(root, input);
    await expect(buildCandidateBundle(buildInput)).rejects.toThrow(
      /outside Git/
    );
    expect(existsSync(buildInput.privateDirectory)).toBe(false);
  });
});
