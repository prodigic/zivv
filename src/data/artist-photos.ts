import type { Artist } from "@/types/events.js";

/** Only current, image-specific approvals belong in this served registry.
 * Research candidates are not approvals. Remove both entry and asset on revocation.
 */
export interface ApprovedArtistPhoto {
  artistId: number;
  artistName: string;
  status: "approved";
  assetPath: string;
  sourceUrl: string;
  rightsUrl: string;
  credit: string;
  reviewedOn: string;
  approvedUse: "artist-directory";
  reuseBasis: "open-license" | "explicit-permission" | "promotional-terms";
  croppingAllowed: boolean;
  expiresOn?: string;
}

// No research catalog has been promoted to publication approval yet (#22/#24).
export const approvedArtistPhotos: readonly ApprovedArtistPhoto[] = [];

/** Bind a reviewed, controlled asset to this exact artist before displaying it. */
export function findApprovedArtistPhoto(
  artist: Pick<Artist, "id" | "name">,
  photos: readonly ApprovedArtistPhoto[] = approvedArtistPhotos,
  today = new Date().toISOString().slice(0, 10)
): ApprovedArtistPhoto | undefined {
  const webLink = (value: string): boolean => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  const validDate = (value: string): boolean => {
    const parsed = Date.parse(value + "T00:00:00Z");
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === value
    );
  };
  return photos.find(
    (photo) =>
      photo.status === "approved" &&
      photo.artistId === artist.id &&
      photo.artistName === artist.name &&
      photo.approvedUse === "artist-directory" &&
      ["open-license", "explicit-permission", "promotional-terms"].includes(
        photo.reuseBasis
      ) &&
      typeof photo.assetPath === "string" &&
      photo.assetPath.startsWith("artist-photos/") &&
      new RegExp("^[A-Za-z0-9_./-]+$").test(photo.assetPath) &&
      photo.assetPath
        .split("/")
        .every((part) => part && part !== "." && part !== "..") &&
      webLink(photo.sourceUrl) &&
      webLink(photo.rightsUrl) &&
      typeof photo.credit === "string" &&
      photo.credit.trim() &&
      validDate(photo.reviewedOn) &&
      photo.reviewedOn <= today &&
      (!photo.expiresOn ||
        (validDate(photo.expiresOn) && photo.expiresOn >= today))
  );
}
