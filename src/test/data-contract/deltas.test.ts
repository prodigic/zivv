import { describe, expect, it } from "vitest";
import { compareRecords } from "./deltas.js";

interface TestRecord {
  id: string;
  value: number;
}

describe("deterministic record deltas", () => {
  it("classifies added, updated, removed, and unchanged records", () => {
    const report = compareRecords<TestRecord>(
      [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
        { id: "d", value: 4 },
      ],
      [
        { id: "a", value: 1 },
        { id: "b", value: 3 },
        { id: "c", value: 3 },
      ],
      (record) => record.id
    );

    expect(report.added.map((delta) => delta.key)).toEqual(["c"]);
    expect(report.updated.map((delta) => delta.key)).toEqual(["b"]);
    expect(report.removed.map((delta) => delta.key)).toEqual(["d"]);
    expect(report.unchanged.map((delta) => delta.key)).toEqual(["a"]);
    expect(report.deduplicated).toEqual([]);
    expect(report.totalBefore).toBe(3);
    expect(report.totalAfter).toBe(3);
  });

  it("sorts keys so repeated runs produce the same report order", () => {
    const first = compareRecords(
      [{ id: "z", value: 1 }, { id: "a", value: 1 }],
      [{ id: "m", value: 1 }, { id: "b", value: 1 }],
      (record) => record.id
    );
    const second = compareRecords(
      [{ id: "a", value: 1 }, { id: "z", value: 1 }],
      [{ id: "b", value: 1 }, { id: "m", value: 1 }],
      (record) => record.id
    );

    expect(first).toEqual(second);
  });

  it("reports duplicate keys that an ingestion stage would collapse", () => {
    const report = compareRecords(
      [{ id: "b", value: 1 }, { id: "a", value: 1 }, { id: "b", value: 2 }],
      [{ id: "a", value: 1 }],
      (record) => record.id
    );

    expect(report.deduplicated).toEqual(["b"]);
  });
});
