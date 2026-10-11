/** @vitest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ArtistVibeCard from "@/components/ui/ArtistVibeCard.js";
import type { ArtistVibe } from "@/types/artist-reviews.js";
afterEach(cleanup);
const vibe: ArtistVibe = {
  summary: "Quiet guitar passages build into loud choruses.",
  basis: "release",
  checkedOn: "2026-10-10",
  reviews: [
    {
      url: "https://review.example/album",
      title: "An album review",
      publication: "Music Journal",
      author: "A Critic",
      publishedOn: "2024-01-01",
      kind: "release",
      reviewedWork: "The Album (2024)",
    },
  ],
};
it("attributes the description to dated reviews and identifies release-only evidence", () => {
  render(<ArtistVibeCard vibe={vibe} />);
  expect(screen.getByText("Based on release reviews")).toBeVisible();
  expect(screen.getByText(/2024-01-01/)).toBeVisible();
  expect(
    screen.getByRole("link", { name: /Music Journal: The Album/ })
  ).toHaveAttribute("href", vibe.reviews[0].url);
});
it("does not render missing research or unsafe source links", () => {
  const { container, rerender } = render(<ArtistVibeCard />);
  expect(container).toBeEmptyDOMElement();
  rerender(
    <ArtistVibeCard
      vibe={{
        ...vibe,
        reviews: [{ ...vibe.reviews[0], url: "javascript:alert(1)" }],
      }}
    />
  );
  expect(container).toBeEmptyDOMElement();
});
