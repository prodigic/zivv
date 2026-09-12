import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Event, Artist, Venue } from "../../types/events.js";
import { bootstrapLedger, loadLedger, saveLedgerAtomic } from "./ledger.js";
import { withIngestionLock } from "./lock.js";
import { writeJsonAtomic } from "./persistence.js";

/** Bootstrap only from the exact existing dataset; never reparse historical text. */
export async function migrateExistingCatalog(
  root: string,
  timestamp = Date.now()
) {
  return withIngestionLock(root, async () => {
    const path = join(root, "data/ingestion/ledger.json");
    if (existsSync(path)) {
      const ledger = await loadLedger(path);
      if (!existsSync(join(root, "data/ingestion/migration.json")))
        throw new Error(
          "Migration evidence is missing; restore migration.json with the ledger."
        );
      return {
        migrated: false,
        events: ledger.events.length,
        message: "Ledger already exists; no backfill repeated.",
      };
    }
    const directory = join(root, "public/data");
    const manifest = JSON.parse(
      readFileSync(join(directory, "manifest.json"), "utf8")
    );
    if (manifest.schemaVersion === "2.0.0")
      throw new Error(
        "A migrated dataset cannot bootstrap a missing ledger. Restore the ledger from version control."
      );
    const filenames = readdirSync(directory)
      .filter((f) => /^events-\d{4}-\d{2}\.json$/.test(f))
      .sort();
    if (Array.isArray(manifest.chunks?.events)) {
      const declared = manifest.chunks.events
        .map((c: { filename: string }) => c.filename)
        .sort();
      if (JSON.stringify(declared) !== JSON.stringify(filenames))
        throw new Error(
          "Historical chunk inventory does not match its manifest"
        );
    }
    const snapshotFiles: Record<string, string> = {};
    const events: Event[] = filenames.flatMap((f) => {
      const bytes = readFileSync(join(directory, f));
      snapshotFiles[f] = createHash("sha256").update(bytes).digest("hex");
      const chunk = JSON.parse(readFileSync(join(directory, f), "utf8"));
      if (!Array.isArray(chunk.events))
        throw new Error(`Invalid historical chunk ${f}`);
      if (
        chunk.chunkId !== f.slice(7, 14) ||
        chunk.events.some((e: Event) => e.date?.slice(0, 7) !== chunk.chunkId)
      )
        throw new Error(`Historical chunk dates do not match ${f}`);
      return chunk.events;
    });
    const artists: Artist[] = JSON.parse(
      readFileSync(join(directory, "artists.json"), "utf8")
    );
    const venues: Venue[] = JSON.parse(
      readFileSync(join(directory, "venues.json"), "utf8")
    );
    if (
      !events.length ||
      events.length !== manifest.totalEvents ||
      artists.length !== manifest.totalArtists ||
      venues.length !== manifest.totalVenues
    )
      throw new Error(
        "Historical snapshot counts do not match its manifest; migration stopped."
      );
    const ledger = bootstrapLedger({ events, artists, venues }, timestamp);
    ledger.events.forEach((e) => {
      e.timeBasis = "legacy-wall-clock";
    });
    const original = new Map(events.map((e) => [e.id, e]));
    for (const e of ledger.events) {
      const prior = original.get(e.id);
      if (
        !prior ||
        (Number.isFinite(prior.createdAtEpochMs) &&
          prior.createdAtEpochMs > 0 &&
          e.createdAtEpochMs !== prior.createdAtEpochMs)
      )
        throw new Error(`Migration changed identity/date added for ${e.id}`);
      if (e.firstImportedBy !== "steveslist")
        throw new Error(`Migration origin incorrect for ${e.id}`);
    }
    const identity = events
      .map((e) => [e.id, e.createdAtEpochMs ?? null])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const report = {
      migrated: true,
      migratedAtEpochMs: timestamp,
      priorDatasetVersion: manifest.datasetVersion,
      basis:
        "User confirmed all prior events were sourced by Steve's List on 2026-09-07",
      events: events.length,
      artists: artists.length,
      venues: venues.length,
      preservedIdentityAndAddedDateSha256: createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex"),
      unknownAddedDates: ledger.events.filter(
        (e) => e.addedDateProvenance === "unknown"
      ).length,
    };
    // Historical manifests had inaccurate size/checksum metadata. Record actual
    // bytes while validating their inventory, dates, references and counts.
    writeJsonAtomic(join(root, "data/ingestion/migration.json"), {
      ...report,
      snapshotFiles,
    });
    await saveLedgerAtomic(path, ledger);
    return report;
  });
}
