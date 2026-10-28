import { createHmac, timingSafeEqual } from "node:crypto";
import {
  validateRecoveryPreparedHostBinding,
  type RecoveryPreparedHostBinding,
} from "./recovery-host-binding.js";
import {
  proveRecoveryGmailSelectedLoadBaseline,
  type RecoveryGmailSelectedLoadBaselineInput,
} from "./recovery-gmail-selected-load-proof.js";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import type { WeeklyRunSource } from "./weekly-run-state.js";

const domain = "zivv-recovery-gmail-selected-load-admission/v1\0";
const maximum = 64 * 1024;
export interface RecoveryGmailSelectedLoadAdmission {
  kind: "zivv-recovery-gmail-selected-load-admission";
  version: 1;
  stopAfter: "load";
  activationAllowed: false;
  captureAllowed: false;
  loadAllowed: false;
  binding: RecoveryPreparedHostBinding;
  admittedAtEpochMs: number;
  baselineSha256: string;
  familySha256: string;
  selectionSha256: string;
  catalogSha256: string;
  journalSha256: string;
  runtimeIdentitySha256: string;
  selector: RecoveryGmailSelectedReceiptSelector;
  source: WeeklyRunSource;
  runId: string;
  runRevision: number;
  runStateSha256: string;
}
export interface RecoveryGmailSelectedLoadAdmissionContext {
  baseline: RecoveryGmailSelectedLoadBaselineInput;
  binding: RecoveryPreparedHostBinding;
}
function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_ADMISSION");
}
function key(value: Buffer): void {
  if (!Buffer.isBuffer(value) || value.length !== 32) fail();
}
function body(
  input: RecoveryGmailSelectedLoadAdmissionContext,
  admittedAtEpochMs: number
): RecoveryGmailSelectedLoadAdmission {
  key(input.baseline.recoveryKey);
  const binding = validateRecoveryPreparedHostBinding(
    input.binding,
    input.baseline.recoveryKey
  );
  const baseline = proveRecoveryGmailSelectedLoadBaseline(input.baseline);
  if (
    !Number.isSafeInteger(admittedAtEpochMs) ||
    admittedAtEpochMs < input.baseline.checkpoint.createdAtEpochMs ||
    admittedAtEpochMs < baseline.source.importObservedAtEpochMs ||
    admittedAtEpochMs > Date.now()
  )
    fail();
  return {
    kind: "zivv-recovery-gmail-selected-load-admission",
    version: 1,
    stopAfter: "load",
    activationAllowed: false,
    captureAllowed: false,
    loadAllowed: false,
    binding,
    admittedAtEpochMs,
    baselineSha256: baseline.baselineSha256,
    familySha256: baseline.selection.familySha256,
    selectionSha256: baseline.selection.selectionSha256,
    catalogSha256: baseline.catalogSha256,
    journalSha256: baseline.journalSha256,
    runtimeIdentitySha256: baseline.runtimeIdentitySha256,
    selector: { ...baseline.selection.selector },
    source: { ...baseline.source },
    runId: baseline.runState.runId,
    runRevision: baseline.runState.revision,
    runStateSha256: sha256(canonicalJson(baseline.runState)),
  };
}
function signed(
  value: RecoveryGmailSelectedLoadAdmission,
  recoveryKey: Buffer
): Buffer {
  const signature = createHmac("sha256", recoveryKey)
    .update(domain)
    .update(canonicalJson(value))
    .digest("hex");
  const bytes = Buffer.from(canonicalJson({ ...value, signature }) + "\n");
  if (bytes.length > maximum) fail();
  return bytes;
}
function read(bytes: Buffer, recoveryKey: Buffer): Record<string, unknown> {
  key(recoveryKey);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum)
    fail();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (
    !bytes.equals(Buffer.from(canonicalJson(record) + "\n")) ||
    typeof record.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.signature)
  )
    fail();
  const { signature, ...payload } = record;
  const expected = createHmac("sha256", recoveryKey)
    .update(domain)
    .update(canonicalJson(payload))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) fail();
  return payload;
}
/** Authenticate immutable intent against the exact original fresh baseline.
 * After load effects, the separate load-delta proof must explain current changes;
 * this function never treats changed catalog/journal evidence as a new baseline.
 * The returned record grants no execution scope or durable installation.
 */
export function authenticateRecoveryGmailSelectedLoadAdmission(
  input: RecoveryGmailSelectedLoadAdmissionContext & { admission: Buffer }
): RecoveryGmailSelectedLoadAdmission {
  try {
    const parsed = read(input.admission, input.baseline.recoveryKey);
    if (typeof parsed.admittedAtEpochMs !== "number") fail();
    const expected = body(input, parsed.admittedAtEpochMs);
    if (canonicalJson(parsed) !== canonicalJson(expected)) fail();
    return expected;
  } catch {
    return fail();
  }
}
/** Deterministic signed intent bytes only. The closed retained executor must
 * install/flush them before key or writer effects and revalidate every scope.
 * One unfinished intent blocks any different baseline, source, host or time.
 */
export function createRecoveryGmailSelectedLoadAdmission(
  input: RecoveryGmailSelectedLoadAdmissionContext & {
    admittedAtEpochMs: number;
    unfinishedAdmissions: readonly Buffer[];
  }
): Buffer {
  try {
    if (
      !Array.isArray(input.unfinishedAdmissions) ||
      input.unfinishedAdmissions.length > 1
    )
      fail();
    if (input.unfinishedAdmissions.length) {
      const admission = input.unfinishedAdmissions[0]!;
      const saved = authenticateRecoveryGmailSelectedLoadAdmission({
        ...input,
        admission,
      });
      if (saved.admittedAtEpochMs !== input.admittedAtEpochMs) fail();
      return Buffer.from(admission);
    }
    return signed(
      body(input, input.admittedAtEpochMs),
      input.baseline.recoveryKey
    );
  } catch {
    return fail();
  }
}
