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
  let protocol: "v1-observation" | "v2-journal-bound" | undefined;
  let parentSha256 = initialSha256,
    previousDeadline = initialIntent.deadlineEpochMs,
    effectiveStart = initialIntent.startedAtEpochMs,
    priorOwner: Record<string, unknown> = { ...initialIntent.previousOwner },
    priorFence = initialIntent.fence,
    priorStart = initialIntent.startedAtEpochMs;
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
    const version = value.version;
    if (version !== 1 && version !== 2) return fail();
    const candidateProtocol =
      version === 1 ? "v1-observation" : "v2-journal-bound";
    if (protocol !== undefined && protocol !== candidateProtocol) return fail();
    protocol = candidateProtocol;
    const expectedKeys =
      version === 1
        ? [
            "kind",
            "version",
            "signature",
            "initialSha256",
            "parentSha256",
            "sequence",
            "startedAtEpochMs",
            "deadlineEpochMs",
          ]
        : [
            "kind",
            "version",
            "signature",
            "initialSha256",
            "parentSha256",
            "sequence",
            "journalSha256",
            "previousOwner",
            "fence",
            "owner",
            "startedAtEpochMs",
            "deadlineEpochMs",
          ];
    if (
      Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",") ||
      value.kind !== "zivv-selected-load-intent-successor" ||
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
    if (version === 2) {
      const previous = value.previousOwner as Record<string, unknown>;
      const sameLease = (
        candidate: Record<string, unknown>,
        expected: Record<string, unknown>
      ) =>
        candidate.scope === expected.scope &&
        candidate.owner === expected.owner &&
        candidate.fence === expected.fence &&
        candidate.expiresAtEpochMs === expected.expiresAtEpochMs;
      const expiry = Number(previous?.expiresAtEpochMs);
      const acquired =
        previous &&
        previous.scope === "prodigic/zivv/production" &&
        previous.owner === initialIntent.owner &&
        previous.fence === priorFence &&
        Number.isSafeInteger(previous.expiresAtEpochMs) &&
        (expiry === 0 || (expiry >= priorStart && expiry <= previousDeadline));
      if (
        typeof value.journalSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.journalSha256) ||
        !previous ||
        typeof previous !== "object" ||
        Array.isArray(previous) ||
        Object.keys(previous).sort().join(",") !==
          "expiresAtEpochMs,fence,owner,scope" ||
        !Number.isSafeInteger(previous.fence) ||
        !Number.isSafeInteger(previous.expiresAtEpochMs) ||
        (!sameLease(previous, priorOwner) && !acquired) ||
        !Number.isSafeInteger(value.fence) ||
        value.fence !== Number(previous.fence) + 1 ||
        !Number.isSafeInteger(Number(previous.fence) + 1) ||
        value.owner !== initialIntent.owner ||
        Number(value.startedAtEpochMs) < Number(previous.expiresAtEpochMs)
      )
        return fail();
    }
    const { signature, ...body } = value;
    const expected = createHmac("sha256", key)
      .update(`zivv-selected-load-intent-successor/v${version}\0`)
      .update(canonicalJson(body))
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature as string, "hex")))
      return fail();
    parentSha256 = sha256(bytes);
    effectiveStart = Number(value.startedAtEpochMs);
    previousDeadline = Number(value.deadlineEpochMs);
    if (version === 2) {
      priorOwner = value.previousOwner as Record<string, unknown>;
      priorFence = Number(value.fence);
      priorStart = Number(value.startedAtEpochMs);
    }
  }
  return {
    initialIntent,
    successorProtocol: protocol ?? "v1-observation",
    initialSha256,
    lastSha256: parentSha256,
    successorCount: successors.length,
    effectiveStartEpochMs: effectiveStart,
    effectiveDeadlineEpochMs: previousDeadline,
    loadAllowed: false as const,
    activationAllowed: false as const,
  };
}
