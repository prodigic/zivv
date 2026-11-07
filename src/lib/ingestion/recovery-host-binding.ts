import { posix, win32 } from "node:path";
import { sha256 } from "./steve-preflight.js";

/** Detached identity commitments shared by closed recovery admissions. No scope,
 * path access or execution permission is established by validating this record. */
export interface RecoveryPreparedHostBinding {
  capsuleSha256: string;
  retirementSha256: string;
  checkpointSha256: string;
  preparedReceiptSha256: string;
  preparedTreeSha256: string;
  preparedImmutableTreeSha256: string;
  physicalRoot: string;
  physicalOperatorDirectory: string;
  physicalNpmPath: string;
  keyId: string;
}
const hashes = [
  "capsuleSha256",
  "retirementSha256",
  "checkpointSha256",
  "preparedReceiptSha256",
  "preparedTreeSha256",
  "preparedImmutableTreeSha256",
  "keyId",
] as const;
const paths = [
  "physicalRoot",
  "physicalOperatorDirectory",
  "physicalNpmPath",
] as const;
function fail(): never {
  throw new Error("INVALID_RECOVERY_PREPARED_HOST_BINDING");
}

/** Preserve the capture admission's exact host-binding rules; independently
 * verified actual filesystem/runtime identities are still mandatory. */
export function validateRecoveryPreparedHostBinding(
  value: unknown,
  recoveryKey: Buffer
): RecoveryPreparedHostBinding {
  if (
    !Buffer.isBuffer(recoveryKey) ||
    recoveryKey.length !== 32 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    fail();
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>([...hashes, ...paths]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  )
    fail();
  const fields = Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      )
        fail();
      return [key, descriptor.value as string];
    })
  ) as Record<string, string>;
  for (const name of hashes) if (!/^[a-f0-9]{64}$/.test(fields[name]!)) fail();
  if (fields.keyId !== sha256(recoveryKey)) fail();
  for (const name of paths) {
    const text = fields[name]!,
      flavor = /^[A-Za-z]:\\/.test(text) ? win32 : posix;
    if (
      text.length > 4096 ||
      [...text].some((character) => character.charCodeAt(0) < 32) ||
      text.startsWith("\\\\") ||
      text.startsWith("//") ||
      !flavor.isAbsolute(text) ||
      flavor.resolve(text) !== text
    )
      fail();
  }
  const flavor = /^[A-Za-z]:\\/.test(fields.physicalRoot!) ? win32 : posix;
  if (
    fields.physicalOperatorDirectory !==
    flavor.join(fields.physicalRoot!, "operator")
  )
    fail();
  return {
    capsuleSha256: fields.capsuleSha256!,
    retirementSha256: fields.retirementSha256!,
    checkpointSha256: fields.checkpointSha256!,
    preparedReceiptSha256: fields.preparedReceiptSha256!,
    preparedTreeSha256: fields.preparedTreeSha256!,
    preparedImmutableTreeSha256: fields.preparedImmutableTreeSha256!,
    physicalRoot: fields.physicalRoot!,
    physicalOperatorDirectory: fields.physicalOperatorDirectory!,
    physicalNpmPath: fields.physicalNpmPath!,
    keyId: fields.keyId!,
  };
}
