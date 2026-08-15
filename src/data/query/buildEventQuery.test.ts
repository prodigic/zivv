import { describe, expect, it } from "vitest";
import { buildEventQuery } from "./buildEventQuery.ts";

describe("buildEventQuery", () => {
  it("centralizes search, filters, sort, and pagination", () => {
    const query = buildEventQuery({
      searchQuery: "  punk  ",
      filters: {
        cities: ["Oakland"],
        dates: ["2026-08-15"],
        priceRange: { max: 30 },
        isFree: false,
        ageRestrictions: ["all-ages"],
        tags: ["outdoor"],
      },
      sortBy: "price",
      sortOrder: "desc",
      limit: 20,
      offset: 40,
    });

    expect(query).toEqual({
      text: "punk",
      filters: {
        cities: ["Oakland"],
        dates: ["2026-08-15"],
        priceRange: { max: 30 },
        isFree: false,
        ageRestrictions: ["all-ages"],
        tags: ["outdoor"],
      },
      sort: "price",
      order: "desc",
      limit: 20,
      offset: 40,
    });
  });

  it("resolves UI venue names to domain venue IDs", () => {
    const query = buildEventQuery(
      { filters: { venues: ["The Fillmore"] } },
      new Map([[7, { id: 7 as never, name: "The Fillmore" } as never]]),
    );

    expect(query.filters?.venueIds).toEqual(["7"]);
  });

  it("does not broaden an unmatched venue filter into an unfiltered query", () => {
    const query = buildEventQuery({ filters: { venues: ["Missing venue"] } });

    expect(query.filters?.venueIds).toEqual(["__no_matching_venue__"]);
  });
});
