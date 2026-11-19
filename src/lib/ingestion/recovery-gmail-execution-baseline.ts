import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { sha256 } from "./steve-preflight.js";

export interface SelectedLoadExecutionBaseline {
  admissionSha256: string;
  evidenceSha256: string;
  physicalSnapshotSha256: string;
  generation: number;
  startedAtEpochMs: number;
  entries: RecoveryRuntimeEntry[];
}
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
    baseline.startedAtEpochMs < 0
  )
    fail();
  validateEntries(baseline.entries);
}

function validateEntries(entries: RecoveryRuntimeEntry[]): void {
  if (!Array.isArray(entries) || entries.length > 50000) fail();
  let previous = "";
  for (const entry of entries) {
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
function signature(body: string, key: Buffer, version: 1 | 2 | 3): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail();
  return createHmac("sha256", key)
    .update("zivv-selected-load-execution-baseline/v" + version + "\0")
    .update(body)
    .digest("hex");
}
/** Detached authenticated evidence only; this grants no execution or replay authority. */
export function signSelectedLoadExecutionBaseline(
  baseline: SelectedLoadExecutionBaseline,
  key: Buffer
): Buffer {
  validate(baseline);
  return encode(baseline, key, 1);
}

function encode(baseline: object, key: Buffer, version: 1 | 2 | 3): Buffer {
  const payload = {
    kind: "zivv-selected-load-execution-baseline",
    version,
    ...baseline,
  };
  return Buffer.from(
    canonicalJson({
      ...payload,
      signature: signature(canonicalJson(payload), key, version),
    }) + "\n"
  );
}
export function verifySelectedLoadExecutionBaseline(
  bytes: Buffer,
  key: Buffer
): SelectedLoadExecutionBaseline {
  const baseline = read(
    bytes,
    key,
    1
  ) as unknown as SelectedLoadExecutionBaseline;
  validate(baseline);
  return structuredClone(baseline);
}

function read(bytes: Buffer, key: Buffer, expectedVersion: 1 | 2 | 3) {
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
    version !== expectedVersion ||
    typeof saved !== "string" ||
    (expectedVersion === 3 && saved.length !== 64) ||
    !/^[a-f0-9]{64}$/.test(saved)
  )
    fail();
  const expected = signature(
    canonicalJson({ kind, version, ...rest }),
    key,
    expectedVersion
  );
  if (!timingSafeEqual(Buffer.from(saved, "hex"), Buffer.from(expected, "hex")))
    fail();
  return rest;
}

export interface SelectedNextLoadExecutionBaseline {
  admissionSha256: string;
  catalogSha256: string;
  journalSha256: string;
  priorLoadFamilySha256: string;
  physicalSnapshotSha256: string;
  generation: 2;
  startedAtEpochMs: number;
  entries: RecoveryRuntimeEntry[];
}

function validateNext(baseline: SelectedNextLoadExecutionBaseline): void {
  if (
    !baseline ||
    Object.keys(baseline).sort().join(",") !==
      [
        "admissionSha256",
        "catalogSha256",
        "entries",
        "generation",
        "journalSha256",
        "physicalSnapshotSha256",
        "priorLoadFamilySha256",
        "startedAtEpochMs",
      ].join(",") ||
    ![
      baseline.admissionSha256,
      baseline.catalogSha256,
      baseline.journalSha256,
      baseline.priorLoadFamilySha256,
      baseline.physicalSnapshotSha256,
    ].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ) ||
    baseline.generation !== 2 ||
    !Number.isSafeInteger(baseline.startedAtEpochMs) ||
    baseline.startedAtEpochMs < 0
  )
    fail();
  validateEntries(baseline.entries);
  if (
    sha256(canonicalJson(baseline.entries)) !== baseline.physicalSnapshotSha256
  )
    fail();
}

/** Retain both SQL commitments and the complete pre-effect file inventory. */
export function signSelectedNextLoadExecutionBaseline(
  baseline: SelectedNextLoadExecutionBaseline,
  key: Buffer
): Buffer {
  validateNext(baseline);
  return encode(baseline, key, 2);
}

/** Authenticate v2 strictly. Fresh host validation still belongs to the caller. */
export function verifySelectedNextLoadExecutionBaseline(
  bytes: Buffer,
  key: Buffer
): SelectedNextLoadExecutionBaseline {
  const baseline = read(
    bytes,
    key,
    2
  ) as unknown as SelectedNextLoadExecutionBaseline;
  validateNext(baseline);
  return structuredClone(baseline);
}

export interface SelectedThirdLoadExecutionBaseline {
  runId: string;
  admissionSha256: string;
  completedPrefixSha256: string;
  preparedReceiptSha256: string;
  catalogSha256: string;
  journalSha256: string;
  predecessorInventorySha256: string;
  physicalSnapshotSha256: string;
  generation: 3;
  startedAtEpochMs: number;
  entries: RecoveryRuntimeEntry[];
}

function validateThird(baseline: SelectedThirdLoadExecutionBaseline): void {
  const fields = [
    "runId",
    "admissionSha256",
    "completedPrefixSha256",
    "preparedReceiptSha256",
    "catalogSha256",
    "journalSha256",
    "predecessorInventorySha256",
    "physicalSnapshotSha256",
  ] as const;
  if (
    !baseline ||
    Object.keys(baseline).sort().join(",") !==
      [...fields, "generation", "startedAtEpochMs", "entries"]
        .sort()
        .join(",") ||
    fields.some((field) => {
      const value = baseline[field];
      return (
        typeof value !== "string" ||
        value.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(value)
      );
    }) ||
    baseline.generation !== 3 ||
    !Number.isSafeInteger(baseline.startedAtEpochMs) ||
    baseline.startedAtEpochMs < 0
  )
    return fail();
  validateEntries(baseline.entries);

  const root = "recovery-gmail-load/" + baseline.runId;
  const expected = [
    { path: root, kind: "directory" },
    { path: root + "/admission.json", kind: "file" },
    { path: root + "/stages", kind: "directory" },
    { path: root + "/stages/admission", kind: "directory" },
  ];
  const predecessor: RecoveryRuntimeEntry[] = [];
  const tail: RecoveryRuntimeEntry[] = [];
  for (const entry of baseline.entries) {
    if (entry.path === root || entry.path.startsWith(root + "/"))
      tail.push(entry);
    else predecessor.push(entry);
  }
  const admission = tail.find(({ path }) => path === root + "/admission.json");
  if (
    canonicalJson(tail.map(({ path, kind }) => ({ path, kind }))) !==
      canonicalJson(expected) ||
    admission?.kind !== "file" ||
    admission.size < 1 ||
    admission.size > 65536 ||
    admission.sha256 !== baseline.admissionSha256 ||
    sha256(canonicalJson(predecessor)) !==
      baseline.predecessorInventorySha256 ||
    sha256(canonicalJson(baseline.entries)) !== baseline.physicalSnapshotSha256
  )
    fail();
}

/** Pin one installed third admission and both verified pre-effect views. */
export function signSelectedThirdLoadExecutionBaseline(
  baseline: SelectedThirdLoadExecutionBaseline,
  key: Buffer
): Buffer {
  validateThird(baseline);
  const bytes = encode(baseline, key, 3);
  if (bytes.length > 32 * 1024 * 1024) return fail();
  return bytes;
}

/** Authenticate the format only. Observing the live state requires separate proof. */
export function verifySelectedThirdLoadExecutionBaseline(
  bytes: Buffer,
  key: Buffer
): SelectedThirdLoadExecutionBaseline {
  const baseline = read(
    bytes,
    key,
    3
  ) as unknown as SelectedThirdLoadExecutionBaseline;
  validateThird(baseline);
  return structuredClone(baseline);
}
