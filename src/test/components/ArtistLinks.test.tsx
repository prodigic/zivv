/** @vitest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ArtistLinks from "@/components/ui/ArtistLinks.js";
import type { ArtistLink } from "@/types/artist-links.js";

const albumLink: ArtistLink = {
  kind: "bandcamp",
  url: "https://exampleband.bandcamp.com/album/demo",
  embed: { albumId: "123456789", title: "Demo Album" },
};

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

it("loads one official album player on request even when the profile link is preferred", () => {
  const { container } = render(
    <ArtistLinks
      artistName="Example Band"
      links={[
        albumLink,
        { kind: "bandcamp", url: "https://exampleband.bandcamp.com/music" },
        { ...albumLink, embed: { albumId: "987654321", title: "Other Album" } },
      ]}
    />
  );
  expect(container.querySelector("iframe")).toBeNull();
  expect(
    screen.getByRole("link", { name: "Bandcamp (opens in a new tab)" })
  ).toHaveAttribute("href", "https://exampleband.bandcamp.com/music");
  const listen = screen.getByRole("button", {
    name: "Listen to Demo Album player",
  });
  expect(listen).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(listen);
  const player = screen.getByTitle("Example Band — Demo Album on Bandcamp");
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  const src = new URL(player.getAttribute("src")!);
  expect(src.origin).toBe("https://bandcamp.com");
  expect(src.pathname).toContain("/album=123456789/");
  expect(src.pathname).toContain("/tracklist=true/");
  expect(src.href).not.toContain("autoplay");
  expect(screen.getByText("Demo Album")).toBeVisible();
  expect(
    screen.getByRole("link", {
      name: "Open Demo Album on Bandcamp (opens in a new tab)",
    })
  ).toHaveAttribute("href", albumLink.url);
});

it("unmounts the player on close and keeps player interactions out of card navigation", () => {
  const navigate = vi.fn();
  const { container } = render(
    <div onClick={navigate}>
      <ArtistLinks artistName="Example Band" links={[albumLink]} />
    </div>
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Demo Album player" })
  );
  fireEvent.click(screen.getByText("Demo Album"));
  fireEvent.click(
    screen.getByRole("link", {
      name: "Open Demo Album on Bandcamp (opens in a new tab)",
    })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Close Demo Album player" })
  );
  expect(container.querySelector("iframe")).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

it.each([
  { ...albumLink, embed: { albumId: "123/evil", title: "Demo Album" } },
  { ...albumLink, url: "https://evil.example/album/demo" },
])(
  "does not offer playback for malformed album metadata or an unsafe destination",
  (link) => {
    const { container } = render(
      <ArtistLinks artistName="Example Band" links={[link]} />
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  }
);

it("closes the previous player when the album or artist changes", () => {
  const { container, rerender } = render(
    <ArtistLinks artistName="Example Band" links={[albumLink]} />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Demo Album player" })
  );
  rerender(
    <ArtistLinks
      artistName="Example Band"
      links={[
        { ...albumLink, embed: { albumId: "987654321", title: "Next Album" } },
      ]}
    />
  );
  expect(container.querySelector("iframe")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Next Album player" })
  );
  rerender(
    <ArtistLinks
      artistName="Different Band"
      links={[
        { ...albumLink, embed: { albumId: "987654321", title: "Next Album" } },
      ]}
    />
  );
  expect(container.querySelector("iframe")).toBeNull();
});
