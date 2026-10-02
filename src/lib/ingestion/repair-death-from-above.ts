import type {
  IngestionLedger,
  LedgerEvent,
  ProvenanceConflict,
} from "../../types/ingestion.js";
import { actualStartEpochMs } from "../discovery.js";
import { StringNormalizer } from "../etl/utils.js";
import { prepareSteveBatch } from "./imports.js";
import { bootstrapLedger } from "./ledger.js";

const evidence =
  "https://www.theuctheatre.org/shows/death-from-above-1979-02-oct";

/** This single legacy record stored an incorrect wall-clock time. Require both
 * retained source bills to parse to the proper listing's known instant before
 * overriding that corruption; other unequal sessions still require review.
 */
function provesCorruptLegacySession(
  malformed: LedgerEvent,
  proper: LedgerEvent,
  content: string,
  timestamp: number
): number[] {
  if (
    malformed.id !== 1992667217 ||
    proper.id !== 1378399671 ||
    malformed.timeBasis !== "legacy-wall-clock" ||
    malformed.startTimeEpochMs !== 1791039600000
  )
    return [];
  const rows = content
    .split(/\r?\n/)
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) =>
      /^oct\s+2\s+2026\s+Death From Above(?:,\s*1979|\s+1979)(?:,\s*Rickshaw Billie's Burger Patrol)?\s+at\s+(?:the\s+)?UC Theat(?:er|re),\s*Berkeley\b/i.test(
        text
      )
    );
  if (!rows.length) return [];
  const empty = bootstrapLedger(
    { events: [], artists: [], venues: [] },
    timestamp
  );
  const batch = prepareSteveBatch(
    empty,
    rows.map((r) => r.text).join("\n"),
    timestamp
  );
  const events = batch.events.map((e) => ("event" in e ? e.event : e));
  if (
    events.length !== 2 ||
    !events.some((e) => e.id === malformed.id) ||
    !events.some((e) => e.id === proper.id) ||
    events.some((e) => actualStartEpochMs(e) !== actualStartEpochMs(proper))
  )
    return [];
  return rows.map((r) => r.line);
}

/** Consolidate the reviewed UC Theatre typo and its officially moved show.
 * Keep the first listing's identity/date-added and the existing August Hall
 * destination's event content. Retired records remain in the returned audit,
 * while redirects and every source observation persist in the ledger.
 */
export function repairDeathFromAbove(
  ledger: IngestionLedger,
  timestamp: number,
  retainedSource = ""
) {
  const next = structuredClone(ledger);
  const names = new Map(next.artists.map((a) => [a.id, a.name]));
  const venues = new Map(next.venues.map((v) => [v.id, v]));
  const uc = next.events.filter(
    (e) =>
      e.date === "2026-10-02" &&
      /^(?:the )?uc theat(?:er|re)$/i.test(venues.get(e.venueId)?.name ?? "") &&
      venues.get(e.venueId)?.city === "Berkeley" &&
      /^(?:Death From Above|Death From Above 1979)$/i.test(
        names.get(e.headlinerArtistId) ?? ""
      )
  );
  if (!uc.length) return { ledger: next, changes: [] };
  const destination = next.events.filter(
    (e) =>
      e.date === "2027-02-11" &&
      /^(?:the )?august hall$/i.test(venues.get(e.venueId)?.name ?? "") &&
      StringNormalizer.normalizeCity(venues.get(e.venueId)?.city ?? "") ===
        "San Francisco" &&
      names.get(e.headlinerArtistId) === "Death From Above 1979"
  );
  if (uc.length !== 2 || destination.length !== 1)
    throw new Error(
      "Missing or ambiguous Death From Above move records; review required"
    );
  const malformed = uc.find(
    (e) =>
      names.get(e.headlinerArtistId) === "Death From Above" &&
      e.artistIds.some((id) => names.get(id) === "1979")
  );
  const proper = uc.find(
    (e) => names.get(e.headlinerArtistId) === "Death From Above 1979"
  );
  const sourceLines =
    malformed && proper
      ? provesCorruptLegacySession(malformed, proper, retainedSource, timestamp)
      : [];
  if (
    !malformed ||
    !proper ||
    malformed.venueId !== proper.venueId ||
    actualStartEpochMs(malformed) === null ||
    (actualStartEpochMs(malformed) !== actualStartEpochMs(proper) &&
      !sourceLines.length) ||
    uc.some(
      (e) =>
        e.sources.some((s) => s.session !== null) ||
        e.tags.includes("multiple-show")
    )
  )
    throw new Error(
      "Death From Above records may be different sessions; review required"
    );
  const target = destination[0];
  if (target.status !== "confirmed")
    throw new Error("August Hall destination needs review");
  const all = [...uc, target];
  const keeper = [...all].sort(
    (a, b) => a.createdAtEpochMs - b.createdAtEpochMs || a.id - b.id
  )[0];
  const retired = all.filter((e) => e.id !== keeper.id);
  const fields = [
    "date",
    "dateEpochMs",
    "venueId",
    "headlinerArtistId",
    "artistIds",
    "startTimeEpochMs",
    "timeBasis",
    "priceMin",
    "priceMax",
    "ageRestriction",
  ] as const;
  const conflicts: ProvenanceConflict[] = fields.flatMap((field) => {
    if (JSON.stringify(keeper[field]) === JSON.stringify(target[field]))
      return [];
    return [
      {
        field,
        existingValue: keeper[field] ?? null,
        incomingValue: target[field] ?? null,
        existingSource: "legacy-catalog",
        incomingSource: `death-from-above-repair:${evidence}`,
        detectedAtEpochMs: timestamp,
        reason: "source-linked-reschedule" as const,
      },
    ];
  });
  const sources = all
    .flatMap((e) => e.sources)
    .filter(
      (s, i, observations) =>
        observations.findIndex(
          (other) => JSON.stringify(other) === JSON.stringify(s)
        ) === i
    );
  const merged: LedgerEvent = {
    ...target,
    notes: [
      target.notes,
      "Moved from the UC Theatre on October 2, 2026. Original ticket purchases remain valid.",
    ]
      .filter(Boolean)
      .join(" "),
    id: keeper.id,
    slug: keeper.slug,
    createdAtEpochMs: keeper.createdAtEpochMs,
    updatedAtEpochMs: Math.max(
      timestamp,
      ...all.map((e) => e.updatedAtEpochMs)
    ),
    firstImportedBy: keeper.firstImportedBy,
    addedDateProvenance: keeper.addedDateProvenance,
    firstImportRunId: keeper.firstImportRunId,
    sources,
    firstObservedAtEpochMs: keeper.firstObservedAtEpochMs,
    announcedAtEpochMs:
      all
        .map((e) => e.announcedAtEpochMs)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b)[0] ?? null,
    provenanceConflicts: [
      ...all.flatMap((e) => e.provenanceConflicts),
      ...conflicts,
    ],
  };
  const retiredIds = new Set(retired.map((e) => e.id));
  next.events = next.events
    .filter((e) => !retiredIds.has(e.id))
    .map((e) => (e.id === keeper.id ? merged : e));
  next.redirects.push(
    ...retired.map((e) => ({
      fromEventId: e.id,
      toEventId: keeper.id,
      reason: "duplicate-merge" as const,
      createdAtEpochMs: timestamp,
    }))
  );
  next.version = `${ledger.version}.death-from-above-repair`;
  return {
    ledger: next,
    changes: [
      {
        keptEventId: keeper.id,
        keptEventBefore: structuredClone(keeper),
        retiredEvents: structuredClone(retired),
        evidence,
        sourceLines,
      },
    ],
  };
}
