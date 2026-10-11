import { artistLinkLabels, type ArtistLink } from "../types/artist-links.js";
import { isPosterUrl } from "./event-poster.js";

const hosts: Partial<Record<ArtistLink["kind"], string[]>> = {
  bandcamp: ["bandcamp.com"],
  spotify: ["open.spotify.com"],
  "apple-music": ["music.apple.com"],
  soundcloud: ["soundcloud.com"],
  youtube: ["youtube.com", "youtu.be"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com"],
  tiktok: ["tiktok.com"],
  bluesky: ["bsky.app"],
  threads: ["threads.net", "threads.com"],
  x: ["x.com", "twitter.com"],
  linktree: ["linktr.ee"],
};

/** Validate transport and platform identity; human research establishes ownership. */
export function isArtistLink(value: unknown): value is ArtistLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<ArtistLink>;
  if (
    !link.kind ||
    !Object.hasOwn(artistLinkLabels, link.kind) ||
    !isPosterUrl(link.url)
  )
    return false;
  const url = new URL(link.url!);
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    !host.includes(".") ||
    /^[\d.:[\]]+$/.test(host)
  )
    return false;
  const allowed = hosts[link.kind];
  if (
    allowed &&
    !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))
  )
    return false;
  if (/[?&](?:redirect_uri|redirect_url|next)=/i.test(url.search)) return false;
  if (
    /^\/(?:intent|share|sharer|sharer\.php|login|accounts|search|explore)(?:\/|$)/i.test(
      url.pathname
    )
  )
    return false;
  if (
    link.kind === "instagram" &&
    /^\/(?:p|reel|reels|stories)\//i.test(url.pathname)
  )
    return false;
  if (
    link.kind === "facebook" &&
    /^\/(?:events|posts|photo|photos|watch|reel|reels)\//i.test(url.pathname)
  )
    return false;
  if (allowed && link.kind !== "bandcamp" && url.pathname === "/") return false;
  if (link.kind === "bandcamp" && /^(?:www\.)?bandcamp\.com$/.test(host))
    return false;
  return true;
}
