import type { EventPoster } from "../types/events.js";

/** Only HTTPS assets and source pages without credentials may be rendered. */
export function isPosterUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Defend the UI boundary when reading legacy or cached public JSON. */
export function isEventPoster(value: unknown): value is EventPoster {
  if (!value || typeof value !== "object") return false;
  const poster = value as Record<string, unknown>;
  return (
    isPosterUrl(poster.imageUrl) &&
    isPosterUrl(poster.eventUrl) &&
    ["poster", "event-artwork"].includes(String(poster.kind)) &&
    typeof poster.checkedOn === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(poster.checkedOn)
  );
}
