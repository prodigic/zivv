import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { verifySelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";

/** Authenticate the full ordered chain supplied by a caller. Directory closure,
 * original state, current time and writer locks are independent obligations;
 * this detached proof grants no execution authority. */
export function verifySelectedLoadIntentChain(
  initial: Buffer,
  successors: Buffer[],
  key: Buffer
) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_INTENT_CHAIN");
  };
  if (!Array.isArray(successors) || successors.length > 10000) return fail();
  const initialIntent = verifySelectedLoadResumeIntent(initial, key);
  const initialSha256 = sha256(initial);
  let parentSha256 = initialSha256,
    previousDeadline = initialIntent.deadlineEpochMs,
    effectiveStart = initialIntent.startedAtEpochMs;
  for (let index = 0; index < successors.length; index++) {
    const bytes = successors[index];
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536) return fail();
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
      return fail();
    if (
      Object.keys(value).sort().join(",") !==
        [
          "kind",
          "version",
          "signature",
          "initialSha256",
          "parentSha256",
          "sequence",
          "startedAtEpochMs",
          "deadlineEpochMs",
        ]
          .sort()
          .join(",") ||
      value.kind !== "zivv-selected-load-intent-successor" ||
      value.version !== 1 ||
      value.initialSha256 !== initialSha256 ||
      value.parentSha256 !== parentSha256 ||
      value.sequence !== index + 1 ||
      typeof value.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.signature) ||
      !Number.isSafeInteger(value.startedAtEpochMs) ||
      Number(value.startedAtEpochMs) < previousDeadline ||
      !Number.isSafeInteger(value.deadlineEpochMs) ||
      value.deadlineEpochMs !== Number(value.startedAtEpochMs) + 180000
    )
      return fail();
    const { signature, ...body } = value;
    const expected = createHmac("sha256", key)
      .update("zivv-selected-load-intent-successor/v1\0")
      .update(canonicalJson(body))
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature as string, "hex")))
      return fail();
    parentSha256 = sha256(bytes);
    effectiveStart = Number(value.startedAtEpochMs);
    previousDeadline = Number(value.deadlineEpochMs);
  }
  return {
    initialIntent,
    initialSha256,
    lastSha256: parentSha256,
    successorCount: successors.length,
    effectiveStartEpochMs: effectiveStart,
    effectiveDeadlineEpochMs: previousDeadline,
    loadAllowed: false as const,
    activationAllowed: false as const,
  };
}
