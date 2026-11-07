import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";

interface SelectedLoadResultExpectation {
  admissionSha256: string;
  executionBaselineSha256: string;
  runId: string;
  ledgerRevision: string;
  generation: number;
  journalSha256: string;
  runStateSha256: string;
  reportSha256: string;
}
/** Authentication only. Callers must independently prove the original admission,
 * current physical files, SQL catalog and complete journal before relying on it. */
export function verifySelectedLoadResult(
  bytes: Buffer,
  key: Buffer,
  expected: SelectedLoadResultExpectation
) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_RESULT");
  };
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 65536 ||
    !Buffer.isBuffer(key) ||
    key.length !== 32
  )
    return fail();
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
  const fields = [
    "kind",
    "version",
    "signature",
    "admissionSha256",
    "executionBaselineSha256",
    "runId",
    "ledgerRevision",
    "generation",
    "journalSha256",
    "guardedJournalSha256",
    "runStateSha256",
    "reportSha256",
  ];
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(fields.sort()) ||
    value.kind !== "zivv-selected-load-result" ||
    value.version !== 1 ||
    typeof value.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.signature) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation !== 2
  )
    return fail();
  for (const field of fields.filter(
    (item) => !["kind", "version", "signature", "generation"].includes(item)
  ))
    if (
      typeof value[field] !== "string" ||
      !/^[a-f0-9]{64}$/.test(value[field] as string)
    )
      return fail();
  const { signature, ...body } = value;
  const actual = createHmac("sha256", key)
    .update("zivv-selected-load-result/v1\0")
    .update(canonicalJson(body))
    .digest();
  if (!timingSafeEqual(Buffer.from(signature as string, "hex"), actual))
    return fail();
  for (const field of Object.keys(
    expected
  ) as (keyof SelectedLoadResultExpectation)[])
    if (value[field] !== expected[field]) return fail();
  if (
    canonicalJson(Object.keys(expected).sort()) !==
    canonicalJson(
      [
        "admissionSha256",
        "executionBaselineSha256",
        "runId",
        "ledgerRevision",
        "generation",
        "journalSha256",
        "runStateSha256",
        "reportSha256",
      ].sort()
    )
  )
    return fail();
  return {
    status: "authenticated" as const,
    guardedJournalSha256: value.guardedJournalSha256 as string,
    resultSha256: createHash("sha256").update(bytes).digest("hex"),
    loadAllowed: false as const,
  };
}
