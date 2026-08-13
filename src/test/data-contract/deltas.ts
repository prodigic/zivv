export type DeltaKind = "added" | "updated" | "removed" | "unchanged";

export interface RecordDelta<T> {
  key: string;
  kind: DeltaKind;
  before?: T;
  after?: T;
}

export interface DeltaReport<T> {
  added: RecordDelta<T>[];
  updated: RecordDelta<T>[];
  removed: RecordDelta<T>[];
  unchanged: RecordDelta<T>[];
  deduplicated: string[];
  totalBefore: number;
  totalAfter: number;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function compareRecords<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (record: T) => string
): DeltaReport<T> {
  const duplicateKeys = (records: readonly T[]): string[] => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const record of records) {
      const key = keyOf(record);
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    return [...duplicates].sort();
  };

  const beforeByKey = new Map(before.map((record) => [keyOf(record), record]));
  const afterByKey = new Map(after.map((record) => [keyOf(record), record]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  const deltas: RecordDelta<T>[] = [];

  for (const key of [...keys].sort()) {
    const previous = beforeByKey.get(key);
    const current = afterByKey.get(key);

    if (previous === undefined && current !== undefined) {
      deltas.push({ key, kind: "added", after: current });
    } else if (previous !== undefined && current === undefined) {
      deltas.push({ key, kind: "removed", before: previous });
    } else if (stableSerialize(previous) === stableSerialize(current)) {
      deltas.push({ key, kind: "unchanged", before: previous, after: current });
    } else {
      deltas.push({ key, kind: "updated", before: previous, after: current });
    }
  }

  return {
    added: deltas.filter((delta) => delta.kind === "added"),
    updated: deltas.filter((delta) => delta.kind === "updated"),
    removed: deltas.filter((delta) => delta.kind === "removed"),
    unchanged: deltas.filter((delta) => delta.kind === "unchanged"),
    deduplicated: [...new Set([...duplicateKeys(before), ...duplicateKeys(after)])].sort(),
    totalBefore: before.length,
    totalAfter: after.length,
  };
}
