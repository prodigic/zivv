/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import VenueMapPreview from "@/components/ui/VenueMapPreview.js";
import { getVenueMapTile } from "@/utils/venue-map.js";
import type { Venue } from "@/types/events.js";

const venue = {
  id: 1 as Venue["id"],
  name: "Test Hall",
  address: "123 Main Street",
  city: "San Francisco",
  mapLocation: {
    latitude: 37.77,
    longitude: -122.42,
    precision: "address" as const,
    sourceUrl: "https://example.com/location",
  },
};

afterEach(cleanup);

// jsdom does not load images, so these tests never request raster tiles.
it("renders one lazy tile with accurate within-tile marker and visible attribution", () => {
  render(<VenueMapPreview venue={venue} />);
  const image = screen.getByRole("img", {
    name: "Street map around Test Hall",
  });
  const tile = getVenueMapTile(venue.mapLocation)!;
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("src", tile.url);
  expect(image).not.toHaveAttribute("referrerpolicy", "no-referrer");
  expect(screen.getByTestId("venue-map-marker")).toHaveStyle({
    left: `${(tile.markerX / 256) * 100}%`,
    top: `${(tile.markerY / 256) * 100}%`,
  });
  const credits = screen.getByRole("link", {
    name: "© OpenStreetMap contributors",
  });
  expect(credits).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/copyright"
  );
  expect(credits).toHaveClass(
    "absolute",
    "bottom-0",
    "right-0",
    "bg-white",
    "text-gray-900"
  );
  expect(credits.parentElement).toBe(image.closest("a")?.parentElement);
  expect(credits.closest("a a")).toBeNull();
  expect(
    screen.getAllByRole("link", { name: "© OpenStreetMap contributors" })
  ).toHaveLength(1);
  expect(screen.getByText(/Approximate address location/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "View on OpenStreetMap" })
  ).toHaveAttribute("href", tile.mapUrl);
});

it("offers an address search without an image or pin when coordinates are unknown", () => {
  render(<VenueMapPreview venue={{ ...venue, mapLocation: undefined }} />);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.queryByTestId("venue-map-marker")).not.toBeInTheDocument();
  const link = screen.getByRole("link", { name: "Search OpenStreetMap" });
  expect(new URL(link.getAttribute("href")!).searchParams.get("query")).toBe(
    "Test Hall, 123 Main Street, San Francisco"
  );
  expect(screen.getByText(/Location has not been mapped/)).toBeInTheDocument();
});

it("keeps map navigation after image failure and retries for a different venue", () => {
  const { rerender } = render(<VenueMapPreview venue={venue} />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText(/Map preview unavailable/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "View on OpenStreetMap" })
  ).toHaveAttribute("href", getVenueMapTile(venue.mapLocation)!.mapUrl);
  rerender(
    <VenueMapPreview
      venue={{ ...venue, id: 2 as Venue["id"], name: "Next Hall" }}
    />
  );
  expect(
    screen.getByRole("img", { name: "Street map around Next Hall" })
  ).toBeInTheDocument();
  expect(screen.queryByText(/Map preview unavailable/)).not.toBeInTheDocument();
});

it.each([
  ["area", /Approximate area/],
  ["site", /Venue site location/],
] as const)(
  "describes %s coordinates without claiming an entrance",
  (precision, caption) => {
    render(
      <VenueMapPreview
        venue={{ ...venue, mapLocation: { ...venue.mapLocation, precision } }}
      />
    );
    expect(screen.getByText(caption)).toHaveTextContent(/entrance/);
  }
);
