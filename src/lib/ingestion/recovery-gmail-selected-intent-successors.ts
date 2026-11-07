import { basename, join } from "node:path";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import { verifySelectedLoadIntentChain } from "./recovery-gmail-selected-intent-chain.js";
import { sha256 } from "./steve-preflight.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";

/** Observe the complete contiguous successor namespace. This read-only proof
 * does not authorize adoption or execution; callers must also prove initial
 * intent, original state, clock and exclusive writer guards. */
export function observeSelectedLoadIntentSuccessors(input: {
  destination: string;
  loadPath: string;
  entries: RecoveryRuntimeEntry[];
  initial: Buffer;
  key: Buffer;
  initialSettled: boolean;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_INTENT_SUCCESSORS");
  };
  if (!/^recovery-gmail-load\/[a-f0-9]{64}$/.test(input.loadPath))
    return fail();
  const prefix = input.loadPath + "/resume-successor-";
  const relevant = input.entries.filter((entry) =>
    entry.path.startsWith(prefix)
  );
  const map = new Map(relevant.map((entry) => [entry.path, entry]));
  if (
    map.size !== relevant.length ||
    (relevant.length > 0 && !input.initialSettled)
  )
    return fail();
  const groups = new Map<number, RecoveryRuntimeEntry[]>();
  for (const entry of relevant) {
    const suffix = entry.path.slice(prefix.length);
    const match = /^(\d{5})\.json(?:-stage(?:\/[^/]+)?)?$/.exec(suffix);
    if (!match) return fail();
    const index = Number(match[1]);
    if (index < 1 || index > 10000) return fail();
    const group = groups.get(index) ?? [];
    group.push(entry);
    groups.set(index, group);
  }
  const seen = new Set<string>(),
    values: Buffer[] = [];
  let incomplete = false;
  for (let index = 1; index <= 10000; index++) {
    const name = `resume-successor-${String(index).padStart(5, "0")}.json`,
      target = input.loadPath + "/" + name,
      stage = target + "-stage";
    const members = groups.get(index) ?? [];
    if (!members.length) break;
    if (incomplete || map.get(stage)?.kind !== "directory") return fail();
    const observed = inspectRecoveryInstalledFile(
      join(input.destination, target),
      join(input.destination, stage),
      65536
    );
    const file = observed.target ?? observed.candidate;
    if (!file) return fail();
    const candidate = observed.candidate
      ? stage + "/" + basename(observed.candidate.path)
      : undefined;
    const allowed = new Set([
      stage,
      ...(observed.target ? [target] : []),
      ...(candidate ? [candidate] : []),
    ]);
    if (
      members.length !== allowed.size ||
      members.some((entry) => !allowed.has(entry.path))
    )
      return fail();
    for (const [path, item] of [
      [target, observed.target],
      [candidate, observed.candidate],
    ] as const) {
      if (!path || !item) continue;
      const entry = map.get(path);
      if (
        !entry ||
        entry.kind !== "file" ||
        entry.size !== item.bytes.length ||
        entry.sha256 !== sha256(item.bytes)
      )
        return fail();
    }
    for (const entry of members) seen.add(entry.path);
    values.push(file.bytes);
    incomplete = !observed.target || !!observed.candidate;
  }
  if (seen.size !== relevant.length) return fail();
  return {
    ...verifySelectedLoadIntentChain(input.initial, values, input.key),
    successorPaths: [...seen].sort(),
    lastSettled: values.length === 0 ? input.initialSettled : !incomplete,
  };
}
