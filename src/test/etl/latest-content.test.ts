import { describe, expect, it } from "vitest";
import { normalizeLatestContent } from "@/lib/etl/latest-content.js";

describe("normalizeLatestContent", () => {
  it("removes the raw email banner and footer while preserving club information", () => {
    const raw = [
      "THE LIST",
      "",
      "funk-punk-thrash-ska  Upcoming shows of Interest August 14, 2026",
      "",
      "aug 14 fri Test Band at Test Venue, Oakland a/a $10 7pm",
      "  C L U B  I N F O R M A T I O N",
      "Test Venue, 1 Main Street, Oakland a/a",
      "----------------------------------------------------------------------------",
      "Please feel free to forward The List on to your friends.",
      "You received this email because you subscribed to our list.",
      "Links:",
      "------",
      "[1] https://example.com",
    ].join("\n");

    expect(normalizeLatestContent(raw)).toBe(
      [
        "funk-punk-thrash-ska  Upcoming shows of Interest August 14, 2026",
        "",
        "aug 14 fri Test Band at Test Venue, Oakland a/a $10 7pm",
        "  C L U B  I N F O R M A T I O N",
        "Test Venue, 1 Main Street, Oakland a/a",
        "",
      ].join("\n")
    );
  });

  it("leaves an already-trimmed latest file unchanged apart from line endings", () => {
    const trimmed = "funk-punk-thrash-ska  Upcoming shows of Interest August 14, 2026\n";
    expect(normalizeLatestContent(trimmed)).toBe(trimmed);
  });
});
