/** Artist-owned destinations supported by reviewed identity evidence. */
export const artistLinkLabels = {
  website: "Website",
  bandcamp: "Bandcamp",
  spotify: "Spotify",
  "apple-music": "Apple Music",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  threads: "Threads",
  x: "X",
  linktree: "Linktree",
} as const;

export type ArtistLinkKind = keyof typeof artistLinkLabels;
export interface ArtistLink {
  kind: ArtistLinkKind;
  url: string;
  /** Reviewed album identity used to construct the official Bandcamp iframe. */
  embed?: { albumId: string; title: string };
}
