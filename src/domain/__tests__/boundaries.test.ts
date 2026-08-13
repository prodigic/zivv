import { describe, expect, it } from "vitest";
import { artistId, eventId, stableKey, venueId } from "../identifiers.ts";

describe("domain boundaries", () => {
  it("rejects empty identifiers", () => {
    expect(() => stableKey(" ")).toThrow();
    expect(() => eventId("")).toThrow();
    expect(() => artistId("\t")).toThrow();
    expect(() => venueId(" ")).toThrow();
  });

  it("keeps stable keys and display identifiers as separate branded values", () => {
    const key = stableKey("event:one");
    const id = eventId("event-1");
    expect(key).not.toBe(id);
  });
});
