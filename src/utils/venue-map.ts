import type { VenueMapLocation } from "../types/events";

export interface VenueMapTile {
  zoom: number;
  x: number;
  y: number;
  url: string;
  markerX: number;
  markerY: number;
  mapUrl: string;
}

const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const TILE_SIZE = 256;

/** Compute one Slippy tile and local marker pixels without requesting images. */
export function getVenueMapTile(
  location: VenueMapLocation | null | undefined,
  tileTemplate = import.meta.env?.VITE_MAP_TILE_URL || DEFAULT_TILE_URL
): VenueMapTile | null {
  if (
    !location ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    !["address", "site", "area"].includes(location.precision)
  )
    return null;
  const latitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, location.latitude)
  );
  const longitude = ((((location.longitude + 180) % 360) + 360) % 360) - 180;
  const zoom = location.precision === "area" ? 15 : 16;
  const size = 2 ** zoom;
  const tileX = ((longitude + 180) / 360) * size;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const projectedY =
    ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * size;
  const tileY = Math.max(0, Math.min(size - 1e-9, projectedY));
  const x = Math.floor(tileX);
  const y = Math.floor(tileY);
  if (
    !/\{z\}/.test(tileTemplate) ||
    !/\{x\}/.test(tileTemplate) ||
    !/\{y\}/.test(tileTemplate)
  )
    return null;
  const url = tileTemplate
    .replaceAll("{z}", String(zoom))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y));
  try {
    const parsedUrl = new URL(url);
    if (
      !["https:", "http:"].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password
    )
      return null;
  } catch {
    return null;
  }
  return {
    zoom,
    x,
    y,
    url,
    markerX: (tileX - x) * TILE_SIZE,
    markerY: (tileY - y) * TILE_SIZE,
    mapUrl: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`,
  };
}
