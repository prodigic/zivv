import { describe, expect, it } from "vitest";
import { discoverSourceSnapshots, loadSourceSnapshot } from "./fixtures.js";

describe("incremental source fixtures", () => {
  it("discovers snapshots in chronological order with predecessor links", () => {
    const snapshots = discoverSourceSnapshots();

    expect(snapshots).toHaveLength(7);
    expect(snapshots.map((snapshot) => snapshot.filename)).toEqual([
      "week-251010.txt",
      "week-251024.txt",
      "week-260109.txt",
      "week-260417.txt",
      "week-260424.txt",
      "week-260508.txt",
      "week-260807.txt",
    ]);
    expect(snapshots[0].predecessor).toBeNull();
    expect(snapshots.slice(1).map((snapshot) => snapshot.predecessor)).toEqual(
      snapshots.slice(0, -1).map((snapshot) => snapshot.filename)
    );
    expect(snapshots.map((snapshot) => snapshot.sourceDate)).toEqual([
      "2025-10-10",
      "2025-10-24",
      "2026-01-09",
      "2026-04-17",
      "2026-04-24",
      "2026-05-08",
      "2026-08-07",
    ]);
  });

  it("loads raw content and deterministic metadata without changing fixtures", () => {
    const snapshot = loadSourceSnapshot("week-260807.txt");

    expect(snapshot.rawText).toContain("Upcoming shows of Interest August 7, 2026");
    expect(snapshot.lineCount).toBe(snapshot.rawText.split(/\r?\n/).length);
    expect(snapshot.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.path.endsWith("data\\steve\\week-260807.txt") || snapshot.path.endsWith("data/steve/week-260807.txt")).toBe(true);
  });
});
