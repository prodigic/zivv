/**
 * Test suite for getVenueMapTile in src/utils/venue-map.ts
 */

import { describe, it, expect, vi } from "vitest";
import { getVenueMapTile } from "@/utils/venue-map";
import type { VenueMapLocation } from "@/types/events";

const TILE_SIZE = 256;
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

// (lon + 180) must round-trip the wrap arithmetic exactly, so mapUrl
// assertions stay free of floating-point noise from the wrap computation.
const addressLocation = (): VenueMapLocation =>
  ({
    latitude: 37.779,
    longitude: -122,
    precision: "address",
  }) as VenueMapLocation;

const AREA_ZOOM = 15;
const SITE_ZOOM = 16;

describe("getVenueMapTile", () => {
  it("returns null for missing or invalid locations", () => {
    expect(getVenueMapTile(null)).toBeNull();
    expect(getVenueMapTile(undefined)).toBeNull();
    expect(
      getVenueMapTile({ ...addressLocation(), latitude: Number.NaN })
    ).toBeNull();
    expect(
      getVenueMapTile({ ...addressLocation(), longitude: Infinity })
    ).toBeNull();
  });

  it("returns null for unsupported precision levels", () => {
    expect(
      getVenueMapTile({ ...addressLocation(), precision: "city" })
    ).toBeNull();
    expect(
      getVenueMapTile({ ...addressLocation(), precision: "unknown" })
    ).toBeNull();
  });

  it("builds a default OpenStreetMap tile URL at site-level zoom", () => {
    const location = addressLocation();
    const tile = getVenueMapTile(location) as NonNullable<
      ReturnType<typeof getVenueMapTile>
    >;

    expect(tile.zoom).toBe(SITE_ZOOM);
    expect(tile.mapUrl).toBe(
      `https://www.openstreetmap.org/?mlat=37.779&mlon=-122#map=16/37.779/-122`
    );
    expect(tile.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/16\//);
    expect(tile.url.endsWith(".png")).toBe(true);
  });

  it("uses the area zoom level for area precision", () => {
    const areaLocation: VenueMapLocation = {
      ...addressLocation(),
      precision: "area",
    } as VenueMapLocation;

    const tile = getVenueMapTile(areaLocation) as NonNullable<
      ReturnType<typeof getVenueMapTile>
    >;

    expect(tile.zoom).toBe(AREA_ZOOM);
    expect(tile.url).toContain(`/15/`);
  });

  it("wraps longitudes beyond ±180", () => {
    const wrapped: VenueMapLocation = {
      ...addressLocation(),
      longitude: 200,
    } as VenueMapLocation;

    const tile = getVenueMapTile(wrapped) as NonNullable<
      ReturnType<typeof getVenueMapTile>
    >;

    // 200°E normalizes to 160°W
    expect(tile.mapUrl).toContain("mlon=-160");
  });

  it("clamps latitudes beyond the Web Mercator limit...", () => {
    const pole: VenueMapLocation = {
      ...addressLocation(),
      latitude: 89.9,
    } as VenueMapLocation;

    const tile = getVenueMapTile(pole) as NonNullable<
      ReturnType<typeof getVenueMapTile>
    >;

    expect(tile.y).toBe(0);
  });

  it("places the marker inside a single tile", () => {
    const tile = getVenueMapTile(addressLocation()) as NonNullable<
      ReturnType<typeof getVenueMapTile>
    >;

    expect(Number.isInteger(tile.x)).toBe(true);
    expect(Number.isInteger(tile.y)).toBe(true);
    expect(tile.markerX).toBeGreaterThanOrEqual(0);
    expect(tile.markerX).toBeLessThan(TILE_SIZE);
    expect(tile.markerY).toBeGreaterThanOrEqual(0);
    expect(tile.markerY).toBeLessThan(TILE_SIZE);
  });

  it("substitutes the custom tile template when provided", () => {
    const tile = getVenueMapTile(
      addressLocation(),
      "https://tiles.example.org/{z}/{x}/{y}.png"
    ) as NonNullable<ReturnType<typeof getVenueMapTile>>;

    expect(tile.url).toMatch(/^https:\/\/tiles\.example\.org\/16\//);
  });

  it("returns null when the template lacks tile coordinates", () => {
    expect(
      getVenueMapTile(addressLocation(), "https://x/{z}/{x}.png")
    ).toBeNull();
    expect(getVenueMapTile(addressLocation(), "https://x/{z}.png")).toBeNull();
    expect(getVenueMapTile(addressLocation(), "https://x/{y}.png")).toBeNull();
  });

  it("returns null for non-http(s) or unparseable template URLs", () => {
    expect(
      getVenueMapTile(addressLocation(), "ftp://tiles/{z}/{x}/{y}.png")
    ).toBeNull();
    expect(
      getVenueMapTile(
        addressLocation(),
        "https://user:pass@tile.openstreetmap.org/{z}/{x}/{y}.png"
      )
    ).toBeNull();
    expect(getVenueMapTile(addressLocation(), "not a url at all")).toBeNull();
  });

  it("honours VITE_MAP_TILE_URL when defined", () => {
    vi.stubEnv("VITE_MAP_TILE_URL", "https://env.example.org/{z}/{x}/{y}.png");

    const tile = getVenueMapTile(addressLocation()) as NonNullable<
      ReturnType<typeof getVenueMapTile>
    >;

    vi.unstubAllEnvs();

    expect(tile.url).toMatch(/^https:\/\/env\.example\.org\/16\//);
  });
});
