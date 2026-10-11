/** @vitest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ArtistLinks from "@/components/ui/ArtistLinks.js";

afterEach(cleanup);
it("shows one link per platform and prefers an observed artist profile to a release", () => {
  render(
    <ArtistLinks
      artistName="Band"
      links={[
        {
          kind: "bandcamp",
          url: "https://exampleband.bandcamp.com/album/demo",
        },
        { kind: "bandcamp", url: "https://exampleband.bandcamp.com/music" },
        { kind: "instagram", url: "https://instagram.com/exampleband/" },
        { kind: "instagram", url: "https://www.instagram.com/exampleband/" },
      ]}
    />
  );
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(
    screen.getByRole("link", { name: "Bandcamp (opens in a new tab)" })
  ).toHaveAttribute("href", "https://exampleband.bandcamp.com/music");
});

it("opens the observed artist destination without triggering the card navigation", () => {
  const navigate = vi.fn();
  render(
    <div onClick={navigate}>
      <ArtistLinks
        artistName="Example Band"
        links={[
          {
            kind: "bandcamp",
            url: "https://exampleband.bandcamp.com/album/demo",
          },
        ]}
      />
    </div>
  );
  const link = screen.getByRole("link", {
    name: "Bandcamp (opens in a new tab)",
  });
  expect(
    screen.getByRole("navigation", { name: "Example Band links" })
  ).toBeVisible();
  expect(link).toHaveAttribute(
    "href",
    "https://exampleband.bandcamp.com/album/demo"
  );
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  fireEvent.click(link);
  expect(navigate).not.toHaveBeenCalled();
});
it("omits absent, unsafe and mislabelled platform destinations", () => {
  const { container, rerender } = render(<ArtistLinks artistName="Band" />);
  expect(container).toBeEmptyDOMElement();
  rerender(
    <ArtistLinks
      artistName="Band"
      links={[
        { kind: "bandcamp", url: "javascript:alert(1)" },
        { kind: "instagram", url: "https://unrelated.example/profile" },
      ]}
    />
  );
  expect(container).toBeEmptyDOMElement();
});
