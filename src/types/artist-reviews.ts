/** Original criticism underlying an attributed listening guide. */
export interface ArtistReview {
  url: string;
  title: string;
  publication: string;
  author: string | null;
  publishedOn: string | null;
  kind: "live" | "release";
  reviewedWork: string;
}
export interface ArtistVibe {
  summary: string;
  basis: "live" | "release" | "mixed";
  checkedOn: string;
  reviews: ArtistReview[];
}
