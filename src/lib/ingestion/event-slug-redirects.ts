import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "../../types/events.js";
import type { DataIndexes } from "../../types/data.js";

/** Export reviewed old links directly to their surviving event and current month. */
export function buildEventSlugRedirects(
  root: string,
  events: Event[]
): NonNullable<DataIndexes["eventSlugRedirects"]> {
  const path = join(root, "data/event-slug-redirects.json");
  if (!existsSync(path)) return {};
  const rows: { slug: string; eventId: number; source: string }[] = JSON.parse(
    readFileSync(path, "utf8")
  );
  if (!Array.isArray(rows)) throw new Error("Invalid event slug redirects");
  const result: NonNullable<DataIndexes["eventSlugRedirects"]> = {};
  for (const row of rows) {
    const target = events.find((event) => event.id === row.eventId);
    if (
      typeof row.slug !== "string" ||
      !/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(row.slug) ||
      Object.hasOwn(result, row.slug) ||
      !Number.isSafeInteger(row.eventId) ||
      !target ||
      events.some(
        (event) => event.slug === row.slug && event.id !== row.eventId
      ) ||
      typeof row.source !== "string" ||
      !row.source.startsWith("https://")
    )
      throw new Error(`Invalid event slug redirect: ${row.slug}`);
    result[row.slug] = { eventId: target.id, chunkId: target.date.slice(0, 7) };
  }
  return result;
}
