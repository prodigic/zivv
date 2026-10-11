/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import EventPosterLink from "@/components/ui/EventPosterLink.js";
import type { EventPoster } from "@/types/events.js";

afterEach(cleanup);
const poster: EventPoster = {
  imageUrl: "https://venue.example/poster.jpg",
  eventUrl: "https://venue.example/show",
  kind: "poster",
  checkedOn: "2026-10-10",
};

it("opens the official show without triggering its surrounding venue card", () => {
  const navigate = vi.fn();
  render(
    <div onClick={navigate}>
      <EventPosterLink poster={poster} showName="Test Band" />
    </div>
  );
  const link = screen.getByRole("link", {
    name: /Test Band poster.*official show page/,
  });
  expect(link).toHaveAttribute("href", poster.eventUrl);
  expect(link).toHaveAttribute("target", "_blank");
  // Prevent jsdom's unimplemented external navigation, while testing bubbling.
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(navigate).not.toHaveBeenCalled();
});

it("keeps the official link and fixed frame when an image fails, and retries a different image", () => {
  const { container, rerender } = render(
    <EventPosterLink poster={poster} showName="Test Band" />
  );
  const frame = screen.getByRole("link");
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link")).toBe(frame);
  expect(frame).toHaveClass("h-11", "w-9");
  rerender(
    <EventPosterLink
      poster={{ ...poster, imageUrl: "https://venue.example/new.jpg" }}
      showName="Next Band"
    />
  );
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "https://venue.example/new.jpg"
  );
});

it.each([
  undefined,
  { ...poster, eventUrl: "javascript:alert(1)" },
  { ...poster, imageUrl: "https://user:secret@venue.example/image" },
])("omits missing or unsafe artwork", (value) => {
  const { container } = render(
    <EventPosterLink poster={value} showName="Test Band" />
  );
  expect(container).toBeEmptyDOMElement();
});
