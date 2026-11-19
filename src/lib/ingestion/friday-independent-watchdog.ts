import { verify, type KeyObject } from "node:crypto";
import type { FridayMonitorEvaluation } from "./friday-monitor-evidence.js";
import { canonicalJson } from "./sqlite-store.js";

interface WatchdogInput {
  bytes: Buffer;
  publicKey: KeyObject;
  editionId: string;
  expectedStartEpochMs: number;
  nowEpochMs: number;
  maxEvidenceAgeMs: number;
}

const kind = "zivv-friday-independent-watchdog";
const domain = kind + "/v1\0";

function invalid(): never {
  throw Error("FRIDAY_WATCHDOG_OBSERVATION_UNVERIFIED");
}

function validInstant(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    Number.isFinite(new Date(value).getTime())
  );
}

/** Authenticate one exact observation from the separately configured watchdog.
 * The issuer is responsible for observing the start registry independently. */
export function readVerifiedFridayWatchdogEvidence({
  bytes,
  publicKey,
  editionId,
  expectedStartEpochMs,
  nowEpochMs,
  maxEvidenceAgeMs,
}: WatchdogInput): FridayMonitorEvaluation {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > 4096 ||
      publicKey.type !== "public" ||
      publicKey.asymmetricKeyType !== "ed25519"
    )
      return invalid();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return invalid();
    const fields = value as Record<string, unknown>;
    const { status, observedAtEpochMs, coveredThroughEpochMs, signature } =
      fields;
    if (
      fields.kind !== kind ||
      fields.version !== 1 ||
      fields.editionId !== editionId ||
      fields.expectedStartEpochMs !== expectedStartEpochMs ||
      !validInstant(expectedStartEpochMs) ||
      !validInstant(observedAtEpochMs) ||
      !validInstant(nowEpochMs) ||
      observedAtEpochMs > nowEpochMs ||
      !Number.isSafeInteger(maxEvidenceAgeMs) ||
      maxEvidenceAgeMs < 0 ||
      (status !== "started" &&
        status !== "not-started" &&
        status !== "unknown") ||
      (status === "unknown"
        ? coveredThroughEpochMs !== null
        : !validInstant(coveredThroughEpochMs) ||
          coveredThroughEpochMs > observedAtEpochMs) ||
      typeof signature !== "string" ||
      signature.length !== 128 ||
      !/^[a-f0-9]{128}$/.test(signature)
    )
      return invalid();

    const body = {
      kind,
      version: 1,
      editionId,
      expectedStartEpochMs,
      observedAtEpochMs,
      coveredThroughEpochMs,
      status,
    };
    const payload = canonicalJson(body);
    if (
      !bytes.equals(
        Buffer.from(canonicalJson({ ...body, signature }) + "\n")
      ) ||
      !verify(
        null,
        Buffer.from(domain + payload),
        publicKey,
        Buffer.from(signature, "hex")
      )
    )
      return invalid();

    return {
      editionId,
      nowEpochMs,
      maxEvidenceAgeMs,
      evidence: {
        kind: "independent-watchdog",
        status,
        expectedStartEpochMs,
        observedAtEpochMs: validInstant(coveredThroughEpochMs)
          ? coveredThroughEpochMs
          : observedAtEpochMs,
      },
    };
  } catch {
    return invalid();
  }
}
