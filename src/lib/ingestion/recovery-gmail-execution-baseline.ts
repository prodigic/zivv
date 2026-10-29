import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";

export interface SelectedLoadExecutionBaseline {
  admissionSha256: string;
  evidenceSha256: string;
  physicalSnapshotSha256: string;
  generation: number;
  startedAtEpochMs: number;
  entries: RecoveryRuntimeEntry[];
}
const domain = "zivv-selected-load-execution-baseline/v1\0";
function fail(): never {
  throw Error("INVALID_SELECTED_LOAD_EXECUTION_BASELINE");
}
function validate(baseline: SelectedLoadExecutionBaseline): void {
  if (
    !baseline ||
    Object.keys(baseline).sort().join(",") !==
      [
        "admissionSha256",
        "entries",
        "evidenceSha256",
        "generation",
        "physicalSnapshotSha256",
        "startedAtEpochMs",
      ]
        .sort()
        .join(",") ||
    ![
      baseline.admissionSha256,
      baseline.evidenceSha256,
      baseline.physicalSnapshotSha256,
    ].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ) ||
    baseline.generation !== 1 ||
    !Number.isSafeInteger(baseline.startedAtEpochMs) ||
    baseline.startedAtEpochMs < 0 ||
    !Array.isArray(baseline.entries) ||
    baseline.entries.length > 50000
  )
    fail();
  let previous = "";
  for (const entry of baseline.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.length > 4096 ||
      entry.path.includes("\\") ||
      entry.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      entry.path <= previous
    )
      fail();
    previous = entry.path;
    if (entry.kind === "directory") {
      if (Object.keys(entry).sort().join(",") !== "kind,path") fail();
    } else if (entry.kind === "file") {
      if (
        Object.keys(entry).sort().join(",") !== "kind,path,sha256,size" ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
        fail();
    } else if (entry.kind === "symlink") {
      if (
        Object.keys(entry).sort().join(",") !== "kind,path,target" ||
        typeof entry.target !== "string" ||
        !entry.target
      )
        fail();
    } else fail();
  }
}
function signature(body: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail();
  return createHmac("sha256", key).update(domain).update(body).digest("hex");
}
/** Detached authenticated evidence only; this grants no execution or replay authority. */
export function signSelectedLoadExecutionBaseline(
  baseline: SelectedLoadExecutionBaseline,
  key: Buffer
): Buffer {
  validate(baseline);
  const payload = {
    kind: "zivv-selected-load-execution-baseline",
    version: 1,
    ...baseline,
  };
  return Buffer.from(
    canonicalJson({
      ...payload,
      signature: signature(canonicalJson(payload), key),
    }) + "\n"
  );
}
export function verifySelectedLoadExecutionBaseline(
  bytes: Buffer,
  key: Buffer
): SelectedLoadExecutionBaseline {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) fail();
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return fail();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !bytes.equals(Buffer.from(canonicalJson(value) + "\n"))
  )
    fail();
  const { signature: saved, kind, version, ...rest } = value;
  if (
    kind !== "zivv-selected-load-execution-baseline" ||
    version !== 1 ||
    typeof saved !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved)
  )
    fail();
  const expected = signature(canonicalJson({ kind, version, ...rest }), key);
  if (!timingSafeEqual(Buffer.from(saved, "hex"), Buffer.from(expected, "hex")))
    fail();
  const baseline = rest as unknown as SelectedLoadExecutionBaseline;
  validate(baseline);
  return structuredClone(baseline);
}
