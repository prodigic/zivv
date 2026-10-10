import { test, expect } from "@playwright/test";
import manifest from "../public/data/manifest.json" with { type: "json" };
import indexes from "../public/data/indexes.json" with { type: "json" };

// Identical content isolates the status badge from title length and show notes.
const events = ["confirmed", "sold-out", "confirmed"].map((status, index) => ({
  id: index + 1,
  slug: `2027-01-0${index + 1}-layout-show`,
  date: `2027-01-0${index + 1}`,
  dateEpochMs: Date.parse(`2027-01-0${index + 1}T20:00:00-08:00`),
  startTimeEpochMs: Date.parse(`2027-01-0${index + 1}T19:00:00-08:00`),
  headlinerArtistId: 1,
  artistIds: [1],
  venueId: 2,
  status,
  tags: [],
  priceMin: 25,
  ageRestriction: "all-ages",
  createdAtEpochMs: Date.parse("2026-10-01T12:00:00Z"),
}));

test("stepping through sold-out shows keeps the header and show tile steady", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-10T12:00:00Z"));
  const upcomingEvents = events.map((event) => ({
    ...event,
    headlinerName: "Layout Test Artist",
    venueName: "Layout Test Venue",
  }));
  const previous = {
    ...events[0],
    id: 10,
    venueId: 3,
    slug: "2027-01-01-previous-venue",
  };
  const next = {
    ...events[0],
    id: 20,
    venueId: 4,
    slug: "2027-01-01-next-venue",
  };
  const fixtures: Record<string, unknown> = {
    "manifest.json": {
      ...manifest,
      datasetVersion: "event-navigation-layout-test",
      totalEvents: 5,
      totalArtists: 1,
      totalVenues: 4,
      chunks: {
        ...manifest.chunks,
        events: [{ chunkId: "2027-01", filename: "events-2027-01.json" }],
      },
    },
    "events-2027-01.json": {
      chunkId: "2027-01",
      events: [...events, previous, next],
    },
    "artists.json": [
      {
        id: 1,
        name: "Layout Test Artist",
        slug: "layout-test-artist",
        upcomingEvents,
      },
    ],
    "venues.json": [
      { id: 4, name: "Z Venue", upcomingEvents: [next] },
      { id: 5, name: "M Empty Venue", upcomingEvents: [] },
      {
        id: 2,
        name: "Layout Test Venue",
        slug: "layout-test-venue",
        city: "San Francisco",
        upcomingEvents,
      },
      { id: 3, name: "A Venue", upcomingEvents: [previous] },
    ],
    "indexes.json": { ...indexes, eventSlugRedirects: {} },
  };
  await page.route("**/data/*.json", async (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").pop()!;
    if (filename in fixtures) await route.fulfill({ json: fixtures[filename] });
    else await route.continue();
  });
  await page.goto(`/zivv/events/${events[0].slug}`);
  const heading = page.getByRole("heading", {
    name: "Layout Test Artist",
    level: 1,
  });
  const tile = page.getByRole("article", {
    name: "Show details and venue map",
  });
  await expect(heading).toBeVisible();
  await expect(tile).toBeVisible();
  await expect(heading.locator("..")).toContainText("$25 · 7:00 PM");
  await expect(heading.locator("..")).not.toContainText("Layout Test Venue");
  const geometry = () =>
    heading.evaluate((element) => ({
      headerHeight: element.parentElement!.getBoundingClientRect().height,
      tileTop: document.querySelector(".event-atlas")!.getBoundingClientRect()
        .top,
    }));
  const initial = await geometry();

  for (const [key, index] of [
    ["ArrowDown", 1],
    ["ArrowDown", 2],
    ["ArrowUp", 1],
    ["ArrowUp", 0],
  ] as const) {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(new RegExp(`${events[index].slug}$`));
    await expect(
      heading.locator("..").getByText("SOLD OUT", { exact: true })
    ).toHaveCount(index === 1 ? 1 : 0);
    expect(await geometry()).toEqual(initial);
  }

  // Venue order is independent of JSON insertion order and skips empty venues.
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(new RegExp(`${next.slug}$`));
  await expect(
    page.getByRole("button", { name: "Next venue", exact: true })
  ).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(new RegExp(`${next.slug}$`));
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(new RegExp(`${events[0].slug}$`));
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(new RegExp(`${previous.slug}$`));
  await expect(
    page.getByRole("button", { name: "Previous venue", exact: true })
  ).toBeDisabled();

  const search = page.getByRole("textbox", {
    name: "Search artists, venues, and events",
  });
  await search.fill("Layout");
  await search.press("ArrowRight");
  await expect(page).toHaveURL(new RegExp(`${previous.slug}$`));
  await search.fill("");
  await page.getByRole("button", { name: "Next venue", exact: true }).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page).toHaveURL(new RegExp(`${previous.slug}$`));
  await page.getByRole("button", { name: "Next venue", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${events[0].slug}$`));
});
