import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  canonicalJson,
  ledgerDigest,
} from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  createRecoveryGmailSelectedLoadAdmission,
  authenticateRecoveryGmailSelectedLoadAdmission,
  type RecoveryGmailSelectedLoadAdmissionContext,
} from "../../lib/ingestion/recovery-gmail-selected-load-admission-proof.js";
import { validateRecoveryPreparedHostBinding } from "../../lib/ingestion/recovery-host-binding.js";
import { createRecoveryGmailSelectedLoadFixture } from "./fixtures/recovery-gmail-selected-load-fixture.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
const domain = "zivv-recovery-gmail-selected-load-admission/v1\0";
let fixture: Awaited<ReturnType<typeof createRecoveryGmailSelectedLoadFixture>>;
let context: RecoveryGmailSelectedLoadAdmissionContext;
let admittedAtEpochMs: number;
let admission: Buffer;
beforeAll(async () => {
  fixture = await createRecoveryGmailSelectedLoadFixture();
  const root = dirname(fixture.baseline.checkpoint.originalOperatorDirectory);
  context = {
    baseline: fixture.baseline,
    binding: {
      capsuleSha256: "1".repeat(64),
      retirementSha256: "2".repeat(64),
      checkpointSha256: "3".repeat(64),
      preparedReceiptSha256: "4".repeat(64),
      preparedTreeSha256: "5".repeat(64),
      preparedImmutableTreeSha256: "6".repeat(64),
      physicalRoot: root,
      physicalOperatorDirectory: join(root, "operator"),
      physicalNpmPath: join(root, "npm", "npm-cli.js"),
      keyId: sha256(fixture.baseline.recoveryKey),
    },
  };
  admittedAtEpochMs = Date.now() - 1_000;
  admission = createRecoveryGmailSelectedLoadAdmission({
    ...context,
    admittedAtEpochMs,
    unfinishedAdmissions: [],
  });
});
afterAll(() => fixture?.cleanup());
function auth(bytes = admission, expected = context) {
  return authenticateRecoveryGmailSelectedLoadAdmission({
    ...expected,
    admission: bytes,
  });
}
function reject(bytes: Buffer, expected = context) {
  expect(() => auth(bytes, expected)).toThrow(
    "INVALID_RECOVERY_GMAIL_SELECTED_LOAD_ADMISSION"
  );
}
function resign(
  change: (value: Record<string, unknown>) => void,
  signingDomain = domain
) {
  const { signature, ...value } = JSON.parse(
    admission.toString("utf8")
  ) as Record<string, unknown>;
  void signature;
  change(value);
  const signed = createHmac("sha256", context.baseline.recoveryKey)
    .update(signingDomain)
    .update(canonicalJson(value))
    .digest("hex");
  return Buffer.from(canonicalJson({ ...value, signature: signed }) + "\n");
}
it("binds exact source, normal run and host without granting a capability", () => {
  const value = auth();
  expect(value).toMatchObject({
    kind: "zivv-recovery-gmail-selected-load-admission",
    version: 1,
    stopAfter: "load",
    activationAllowed: false,
    captureAllowed: false,
    loadAllowed: false,
    admittedAtEpochMs,
    binding: context.binding,
    selector: context.baseline.selector,
  });
  expect(value.source.rawSha256).not.toBe(value.selector.rawSha256);
  expect(value.runId).toBeTruthy();
  expect(value.baselineSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(admission).toEqual(
    createRecoveryGmailSelectedLoadAdmission({
      ...context,
      admittedAtEpochMs,
      unfinishedAdmissions: [],
    })
  );
});
it("reuses exact saved bytes and refuses new admission time or overlapping intent", () => {
  const saved = Buffer.from(admission);
  const reused = createRecoveryGmailSelectedLoadAdmission({
    ...context,
    admittedAtEpochMs,
    unfinishedAdmissions: [saved],
  });
  expect(reused).toEqual(saved);
  reused[0] = 0;
  expect(saved).toEqual(admission);
  expect(() =>
    createRecoveryGmailSelectedLoadAdmission({
      ...context,
      admittedAtEpochMs: admittedAtEpochMs + 1,
      unfinishedAdmissions: [saved],
    })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_ADMISSION");
  expect(() =>
    createRecoveryGmailSelectedLoadAdmission({
      ...context,
      admittedAtEpochMs,
      unfinishedAdmissions: [saved, saved],
    })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_ADMISSION");
});
it("refuses a different physical host, capsule, preparation or key binding", () => {
  for (const change of [
    { capsuleSha256: "a".repeat(64) },
    { retirementSha256: "b".repeat(64) },
    { preparedReceiptSha256: "c".repeat(64) },
    { physicalNpmPath: join(context.binding.physicalRoot, "other-npm.js") },
  ])
    reject(admission, {
      ...context,
      binding: { ...context.binding, ...change },
    });
  reject(admission, {
    ...context,
    baseline: { ...context.baseline, recoveryKey: Buffer.alloc(32, 8) },
  });
  reject(admission, {
    ...context,
    baseline: { ...context.baseline, recoveryKey: Buffer.alloc(31) },
  });
});
it("refuses a changed valid catalog baseline even when its revision commitment is refreshed", () => {
  const ledger = structuredClone(context.baseline.checkpoint.ledger);
  ledger.version = String(Number(ledger.version) + 1);
  reject(admission, {
    ...context,
    baseline: {
      ...context.baseline,
      currentLedger: ledger,
      checkpoint: {
        ...context.baseline.checkpoint,
        ledger,
        ledgerRevision: ledgerDigest(ledger),
      },
    },
  });
  reject(admission, {
    ...context,
    baseline: {
      ...context.baseline,
      selector: { ...context.baseline.selector, messageId: "b1" },
    },
  });
  expect(admission).toEqual(
    createRecoveryGmailSelectedLoadAdmission({
      ...context,
      admittedAtEpochMs,
      unfinishedAdmissions: [admission],
    })
  );
});
it("rejects valid-HMAC schema, source, run, baseline and capability substitutions", () => {
  for (const change of [
    (value: Record<string, unknown>) => {
      value.kind = "other-admission";
    },
    (value: Record<string, unknown>) => {
      value.version = 2;
    },
    (value: Record<string, unknown>) => {
      value.stopAfter = "freeze";
    },
    (value: Record<string, unknown>) => {
      value.loadAllowed = true;
    },
    (value: Record<string, unknown>) => {
      value.runId = "caller-run";
    },
    (value: Record<string, unknown>) => {
      value.baselineSha256 = "f".repeat(64);
    },
    (value: Record<string, unknown>) => {
      value.source = {
        ...(value.source as Record<string, unknown>),
        rawSha256: context.baseline.selector.rawSha256,
      };
    },
    (value: Record<string, unknown>) => {
      value.extraControl = "activate";
    },
  ])
    reject(resign(change));
});
it("rejects signature corruption and a valid signature under another admission domain", () => {
  const value = JSON.parse(admission.toString("utf8")) as Record<
    string,
    unknown
  >;
  value.signature = "f".repeat(64);
  reject(Buffer.from(canonicalJson(value) + "\n"));
  reject(resign(() => {}, "zivv-recovery-gmail-capture-admission/v1\0"));
});
it("requires strict bounded canonical UTF-8 bytes, including BOM and duplicate-key refusal", () => {
  const text = admission.toString("utf8");
  for (const bytes of [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), admission]),
    Buffer.from(text + "\n"),
    Buffer.from(JSON.stringify(JSON.parse(text), null, 2) + "\n"),
    Buffer.from(text.replace('"version":1', '"version":1,"version":1')),
    Buffer.from([0xff]),
    Buffer.alloc(64 * 1024 + 1, 32),
  ])
    reject(bytes);
});
it("enforces admission clock bounds without changing an authenticated original observation", () => {
  for (const time of [
    0,
    context.baseline.checkpoint.createdAtEpochMs - 1,
    Date.now() + 60_000,
    Number.NaN,
  ])
    expect(() =>
      createRecoveryGmailSelectedLoadAdmission({
        ...context,
        admittedAtEpochMs: time,
        unfinishedAdmissions: [],
      })
    ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_ADMISSION");
  const receiptFile = fixture.baseline.checkpoint.files.find(
    (file) =>
      file.area === "operator" &&
      file.path.endsWith(
        "/bodies/" + fixture.baseline.selector.receiptId + "/receipt.json"
      )
  )!;
  const original = JSON.parse(
    Buffer.from(receiptFile.bytes!, "base64").toString("utf8")
  ) as { firstObservedAtEpochMs: number };
  expect(auth().source.importObservedAtEpochMs).toBe(
    original.firstObservedAtEpochMs
  );
});
it("fits bounded long host paths and authenticates detached output", () => {
  const root = "/" + "r".repeat(3980),
    binding = {
      ...context.binding,
      physicalRoot: root,
      physicalOperatorDirectory: root + "/operator",
      physicalNpmPath: "/" + "n".repeat(4095),
    };
  const bytes = createRecoveryGmailSelectedLoadAdmission({
    ...context,
    binding,
    admittedAtEpochMs,
    unfinishedAdmissions: [],
  });
  expect(bytes.length).toBeLessThanOrEqual(64 * 1024);
  const value = auth(bytes, { ...context, binding });
  value.binding.physicalRoot = "changed";
  value.source.deliveryId = "changed";
  expect(auth(bytes, { ...context, binding }).binding.physicalRoot).toBe(root);
  expect(binding.physicalRoot).toBe(root);
});
it("preserves closed host validation and refuses accessors without calling them", () => {
  for (const change of [
    { physicalNpmPath: "relative/npm.js" },
    { physicalRoot: "//server/share" },
    {
      physicalOperatorDirectory: join(context.binding.physicalRoot, "outside"),
    },
    { keyId: "0".repeat(64) },
  ])
    expect(() =>
      validateRecoveryPreparedHostBinding(
        { ...context.binding, ...change },
        context.baseline.recoveryKey
      )
    ).toThrow("INVALID_RECOVERY_PREPARED_HOST_BINDING");
  const getter = vi.fn(() => context.binding.physicalNpmPath);
  const altered = Object.defineProperty(
    { ...context.binding },
    "physicalNpmPath",
    { get: getter, enumerable: true }
  );
  expect(() =>
    validateRecoveryPreparedHostBinding(altered, context.baseline.recoveryKey)
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
