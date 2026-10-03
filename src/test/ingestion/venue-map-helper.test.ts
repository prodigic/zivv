import { afterEach, describe, expect, it, vi } from "vitest";
import type { VenueMapLocation } from "../../types/events.js";
import { getVenueMapTile } from "../../utils/venue-map.js";

const location: VenueMapLocation = {
  latitude: 37.7749,
  longitude: -122.4194,
  precision: "address",
  sourceUrl: "https://venue.example.org/contact",
};
const template = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

describe("venue Slippy tile helper", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the configured provider and falls back to OpenStreetMap", () => {
    vi.stubEnv("VITE_MAP_TILE_URL", "https://maps.example.org/{z}/{x}/{y}.png");
    expect(getVenueMapTile(location)?.url).toBe(
      "https://maps.example.org/16/10482/25331.png"
    );
    vi.stubEnv("VITE_MAP_TILE_URL", "");
    expect(getVenueMapTile(location)?.url).toBe(
      "https://tile.openstreetmap.org/16/10482/25331.png"
    );
  });

  it("locates San Francisco in the standard z16 tile with a local marker", () => {
    const tile = getVenueMapTile(location, template)!;
    expect(tile).toMatchObject({ zoom: 16, x: 10482, y: 25331 });
    expect(tile.url).toBe("https://tile.openstreetmap.org/16/10482/25331.png");
    expect(tile.markerX).toBeGreaterThanOrEqual(0);
    expect(tile.markerX).toBeLessThan(256);
    expect(tile.markerY).toBeGreaterThanOrEqual(0);
    expect(tile.markerY).toBeLessThan(256);
    const map = new URL(tile.mapUrl);
    expect(Number(map.searchParams.get("mlat"))).toBeCloseTo(location.latitude);
    expect(Number(map.searchParams.get("mlon"))).toBeCloseTo(
      location.longitude
    );
    expect(map.hash).toMatch(/^#map=16\//);
  });

  it("uses a broader z15 tile for area precision and substitutes a custom provider", () => {
    const tile = getVenueMapTile(
      { ...location, precision: "area" },
      "https://maps.example.org/{z}/{x}/{y}.png?zoom={z}"
    )!;
    expect(tile.zoom).toBe(15);
    expect(tile.x).toBe(5241);
    expect(tile.y).toBe(12665);
    expect(tile.url).toBe("https://maps.example.org/15/5241/12665.png?zoom=15");
    expect(
      getVenueMapTile({ ...location, precision: "site" }, template)?.zoom
    ).toBe(16);
  });

  it.each([180, -180, 540, -540])(
    "wraps longitude %s at the antimeridian",
    (longitude) => {
      const tile = getVenueMapTile(
        { ...location, latitude: 0, longitude },
        template
      )!;
      expect(tile).toMatchObject({ x: 0, y: 32768, markerX: 0, markerY: 0 });
      expect(new URL(tile.mapUrl).searchParams.get("mlon")).toBe("-180");
    }
  );

  it.each([-90, 90])(
    "clamps latitude %s to valid Web Mercator tiles",
    (latitude) => {
      const tile = getVenueMapTile({ ...location, latitude }, template)!;
      expect(tile.y).toBe(latitude > 0 ? 0 : 65535);
      expect(tile.markerY).toBeGreaterThanOrEqual(0);
      expect(tile.markerY).toBeLessThan(256);
    }
  );

  it("places the equator/prime meridian at the tile origin", () => {
    expect(
      getVenueMapTile({ ...location, latitude: 0, longitude: 0 }, template)
    ).toMatchObject({ x: 32768, y: 32768, markerX: 0, markerY: 0 });
  });

  it("returns no tile for unknown or nonfinite positions", () => {
    expect(getVenueMapTile(null)).toBeNull();
    expect(getVenueMapTile(undefined)).toBeNull();
    expect(getVenueMapTile({ ...location, latitude: NaN })).toBeNull();
    expect(getVenueMapTile({ ...location, longitude: Infinity })).toBeNull();
  });

  it.each([
    "javascript:alert('{z}/{x}/{y}')",
    "https://user:secret@maps.example.org/{z}/{x}/{y}.png",
    "https://maps.example.org/static.png",
    "not-a-url/{z}/{x}/{y}",
  ])("rejects unsafe or incomplete tile templates", (provider) => {
    expect(getVenueMapTile(location, provider)).toBeNull();
  });
});
