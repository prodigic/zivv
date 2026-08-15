import { describe, expect, it } from "vitest";
import { createSlug, normalizeArtistNames, normalizeCity, normalizeName } from "../normalization.ts";

describe("domain normalization", () => {
  it("normalizes names for identity matching without changing display text", () => {
    expect(normalizeName("  Beyoncé's   Band ")).toBe("beyonces band");
    expect(createSlug("Beyoncé's Band")).toBe("beyonces-band");
  });

  it("normalizes common Bay Area city aliases", () => {
    expect(normalizeCity("SF")).toBe("San Francisco");
    expect(normalizeCity("san fran")).toBe("San Francisco");
    expect(normalizeCity("Oakland.")).toBe("Oakland");
  });

  it("preserves multi-artist billing order and records aliases separately", () => {
    expect(normalizeArtistNames([
      { name: "Headliner" },
      { name: "The Support Band", aliasOf: "Support Band" },
      { name: "  " },
    ])).toEqual([
      { displayName: "Headliner", normalizedName: "headliner" },
      { displayName: "The Support Band", normalizedName: "the support band", aliasOf: "support band" },
    ]);
  });
});
