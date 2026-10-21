import { posix, win32 } from "node:path";
import type { OperatorRecoveryCheckpoint } from "./operator-recovery.js";
import {
  authenticateSteveGmailBatchBytes,
  type SteveGmailHandoffBatch,
} from "./steve-gmail-handoff.js";
import {
  selectSteveEmailPlaintext,
  type SteveEmailReceipt,
} from "./steve-email-intake.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";

const acquisition = "email-acquisition";
const batchRoot = acquisition + "/batches";
const scope = "prodigic/zivv/production";
const maxBatchBytes = 32 * 1024 * 1024 + 64 * 1024;
const maxRegistryBytes = 256 * 1024 * 1024;
const maxIntakeBytes = 8 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;

export interface RecoveryGmailBatchProof {
  activationAllowed: false;
  captureAllowed: false;
  physicalValidationRequired: true;
  batches: Array<{
    batch: SteveGmailHandoffBatch;
    messages: Array<
      | { messageId: string; status: "pending" }
      | {
          messageId: string;
          status: "captured";
          receiptId: string;
          disposition: SteveEmailReceipt["disposition"];
        }
    >;
  }>;
}

function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_BATCH_PROOF");
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function object(bytes: Buffer, keys: string[]): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(value) + "\n" !== text ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  )
    fail();
  return value as Record<string, unknown>;
}
function decodedLength(value: unknown, limit: number): number {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4)
    fail();
  const size =
    Math.floor((value.length * 3) / 4) -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (size < 0 || size > limit) fail();
  return size;
}
function base64(value: unknown, limit: number): Buffer {
  decodedLength(value, limit);
  const bytes = Buffer.from(value as string, "base64");
  if (bytes.toString("base64") !== value) fail();
  return bytes;
}

/** Detached captured-state proof only. This neither validates a whole checkpoint nor
 * permits reading an installation, capturing mail, moving roots, or activating writers.
 */
export function proveRecoveryGmailBatchInventory(input: {
  checkpoint: Pick<
    OperatorRecoveryCheckpoint,
    | "originalOperatorDirectory"
    | "createdAtEpochMs"
    | "files"
    | "directories"
    | "journal"
  >;
  recoveryKey?: Buffer;
}): RecoveryGmailBatchProof {
  try {
    return prove(input);
  } catch {
    return fail();
  }
}

function prove(input: Parameters<typeof proveRecoveryGmailBatchInventory>[0]) {
  const checkpoint = input.checkpoint;
  const root = checkpoint.originalOperatorDirectory;
  if (
    !integer(checkpoint.createdAtEpochMs) ||
    checkpoint.createdAtEpochMs > Date.now() ||
    typeof root !== "string" ||
    root.length > 4096 ||
    [...root].some((character) => character.charCodeAt(0) < 32) ||
    root.startsWith("\\\\") ||
    root.startsWith("//") ||
    !Array.isArray(checkpoint.files) ||
    checkpoint.files.length > 50_000 ||
    !Array.isArray(checkpoint.directories) ||
    checkpoint.directories.length > 50_000
  )
    fail();
  const flavor = /^[A-Za-z]:\\/.test(root) ? win32 : posix;
  if (!flavor.isAbsolute(root) || flavor.resolve(root) !== root) fail();
  const result: RecoveryGmailBatchProof = {
    activationAllowed: false,
    captureAllowed: false,
    physicalValidationRequired: true,
    batches: [],
  };
  const files = new Map<string, (typeof checkpoint.files)[number]>();
  const directories = new Set<string>();
  const folded = new Set<string>();
  function inventoryPath(area: string, path: string): string {
    if (
      !["operator", "checkout"].includes(area) ||
      typeof path !== "string" ||
      !path.length ||
      path.length > 4096 ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      fail();
    const name = area + "/" + path;
    if (folded.has(name.toLowerCase())) fail();
    folded.add(name.toLowerCase());
    if (
      area === "operator" &&
      path.split("/")[0]!.toLowerCase() === acquisition &&
      path.split("/")[0] !== acquisition
    )
      fail();
    return name;
  }
  for (const row of checkpoint.directories) {
    const name = inventoryPath(row.area, row.path);
    directories.add(name);
    if (
      row.area === "operator" &&
      row.path.startsWith(acquisition + "/") &&
      row.path !== batchRoot
    )
      fail();
  }
  if (
    directories.has("operator/" + batchRoot) &&
    !directories.has("operator/" + acquisition)
  )
    fail();
  let totalBytes = 0;
  const batchFiles: Array<(typeof checkpoint.files)[number]> = [];
  for (const row of checkpoint.files) {
    files.set(inventoryPath(row.area, row.path), row);
    if (row.area !== "operator") continue;
    if (row.path === acquisition || row.path.startsWith(acquisition + "/")) {
      if (
        !/^email-acquisition\/batches\/[a-f0-9]{64}\.json$/.test(row.path) ||
        !directories.has("operator/" + acquisition) ||
        !directories.has("operator/" + batchRoot) ||
        batchFiles.length >= 1000
      )
        fail();
      batchFiles.push(row);
      totalBytes += decodedLength(row.bytes, maxBatchBytes);
      if (totalBytes > maxRegistryBytes) fail();
    }
  }
  // An absent or empty acquisition area requires neither an archive key nor a journal read.
  if (batchFiles.length === 0) return result;
  if (!Buffer.isBuffer(input.recoveryKey) || input.recoveryKey.length !== 32)
    fail();
  function retained(path: string, limit = maxIntakeBytes): Buffer {
    const row = files.get("operator/" + path);
    if (!row || typeof row.sha256 !== "string" || !hashPattern.test(row.sha256))
      fail();
    const bytes = base64(row.bytes, limit);
    if (sha256(bytes) !== row.sha256) fail();
    return bytes;
  }
  const batches = batchFiles
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((row) => {
      const batch = authenticateSteveGmailBatchBytes({
        bytes: retained(row.path, maxBatchBytes),
        fileName: row.path.slice(batchRoot.length + 1),
        originalOperatorDirectory: root,
        recoveryKey: input.recoveryKey!,
      });
      if (
        batch.firstSavedAtEpochMs > checkpoint.createdAtEpochMs ||
        batch.snapshots.some(
          (snapshot) => snapshot.observedAtEpochMs > batch.firstSavedAtEpochMs
        )
      )
        fail();
      return batch;
    });
  const journal = validateWeeklyJournalRecoverySnapshot(
    base64(checkpoint.journal, maxRegistryBytes)
  );
  const sources = new Map<string, Buffer>();
  const approvals = new Map<string, Buffer>();
  for (const row of journal.intakeEvidence) {
    if (row.scope !== scope) continue;
    (row.kind === "source" ? sources : approvals).set(
      row.id,
      base64(row.bytes, maxIntakeBytes)
    );
  }
  for (const id of approvals.keys()) if (!sources.has(id)) fail();
  const receipts = new Map<string, SteveEmailReceipt>();
  function capture(account: string, messageId: string) {
    const path = `email-intake/${account}/messages/${sha256(messageId)}`;
    const value = object(retained(path + "/capture.json"), [
      "schemaVersion",
      "messageId",
      "accountSha256",
      "rawSha256",
      "sourceSha256",
      "receiptId",
      "receivedAtEpochMs",
    ]);
    if (
      value.schemaVersion !== 1 ||
      value.messageId !== messageId ||
      value.accountSha256 !== account ||
      !hashPattern.test(String(value.rawSha256)) ||
      !hashPattern.test(String(value.sourceSha256)) ||
      !hashPattern.test(String(value.receiptId)) ||
      !integer(value.receivedAtEpochMs) ||
      value.receivedAtEpochMs > checkpoint.createdAtEpochMs ||
      sha256(retained(path + "/message.eml")) !== value.rawSha256
    )
      fail();
    return value;
  }
  function body(id: string, lineage = new Set<string>()): SteveEmailReceipt {
    const cached = receipts.get(id);
    if (cached) return cached;
    if (lineage.size >= 100 || lineage.has(id)) fail();
    lineage.add(id);
    const evidence = sources.get(id);
    if (!evidence) fail();
    const value = object(evidence, [
      "schemaVersion",
      "receiptId",
      "accountSha256",
      "editionId",
      "deliveryId",
      "messageId",
      "rawSha256",
      "sourceSha256",
      "receivedAtEpochMs",
      "firstObservedAtEpochMs",
      "acquisitionObservedAtEpochMs",
      "senderDate",
      "disposition",
      "correctionOf",
      "partPath",
      "receiverProfile",
    ]);
    const receipt = value as unknown as SteveEmailReceipt;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.receiptId !== id ||
      !hashPattern.test(receipt.accountSha256) ||
      !hashPattern.test(receipt.sourceSha256) ||
      !hashPattern.test(receipt.rawSha256) ||
      !/^[a-f0-9]{1,128}$/.test(receipt.messageId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(receipt.editionId) ||
      receipt.deliveryId !== "gmail-" + id ||
      sha256(
        canonicalJson([
          receipt.accountSha256,
          receipt.editionId,
          receipt.sourceSha256,
        ])
      ) !== id ||
      !integer(receipt.firstObservedAtEpochMs) ||
      receipt.firstObservedAtEpochMs > checkpoint.createdAtEpochMs ||
      !integer(receipt.acquisitionObservedAtEpochMs) ||
      receipt.acquisitionObservedAtEpochMs > receipt.firstObservedAtEpochMs ||
      !integer(receipt.receivedAtEpochMs) ||
      receipt.receivedAtEpochMs > receipt.acquisitionObservedAtEpochMs ||
      !Number.isFinite(Date.parse(receipt.senderDate)) ||
      !["ready", "review-required"].includes(receipt.disposition) ||
      !Array.isArray(receipt.partPath) ||
      receipt.partPath.length > 20 ||
      receipt.partPath.some((part) => !integer(part) || part >= 100) ||
      receipt.receiverProfile?.policy !== "steve-gmail-eocampaign-v1" ||
      receipt.receiverProfile.parser !== "postal-mime-4.0.7/gmail-text-v1" ||
      receipt.receiverProfile.issuer !== "mx.google.com" ||
      receipt.receiverProfile.dkimIdentityDomain !== "sp.eocampaign1.com" ||
      receipt.receiverProfile.spfMailFromDomain !== "sp.eocampaign1.com" ||
      !Array.isArray(receipt.receiverProfile.dkimSigningDomains) ||
      !receipt.receiverProfile.dkimSigningDomains.includes(
        "sp.eocampaign1.com"
      ) ||
      ![null, "pass", "none"].includes(receipt.receiverProfile.dmarcResult)
    )
      fail();
    const path = `email-intake/${receipt.accountSha256}/bodies/${id}`;
    if (
      !retained(path + "/receipt.json").equals(evidence) ||
      sha256(retained(path + "/source.txt")) !== receipt.sourceSha256
    )
      fail();
    const original = capture(receipt.accountSha256, receipt.messageId);
    if (
      original.receiptId !== id ||
      original.rawSha256 !== receipt.rawSha256 ||
      original.sourceSha256 !== receipt.sourceSha256 ||
      original.receivedAtEpochMs !== receipt.receivedAtEpochMs
    )
      fail();
    let resolved = receipt;
    const approvalPath = path + "/correction-approval.json";
    const approval = approvals.get(id);
    if (approval || files.has("operator/" + approvalPath)) {
      if (!approval || !retained(approvalPath).equals(approval)) fail();
      const row = object(approval, [
        "schemaVersion",
        "receiptId",
        "correctionOf",
        "approvedAtEpochMs",
      ]);
      if (
        row.schemaVersion !== 1 ||
        row.receiptId !== id ||
        receipt.disposition !== "review-required" ||
        receipt.correctionOf !== null ||
        typeof row.correctionOf !== "string" ||
        !hashPattern.test(row.correctionOf) ||
        !integer(row.approvedAtEpochMs) ||
        row.approvedAtEpochMs < receipt.firstObservedAtEpochMs ||
        row.approvedAtEpochMs > checkpoint.createdAtEpochMs
      )
        fail();
      resolved = {
        ...receipt,
        disposition: "ready",
        correctionOf: row.correctionOf,
      };
    }
    if (resolved.correctionOf !== null) {
      if (!hashPattern.test(resolved.correctionOf)) fail();
      const parent = body(resolved.correctionOf, lineage);
      if (
        parent.accountSha256 !== receipt.accountSha256 ||
        parent.editionId !== receipt.editionId ||
        parent.disposition !== "ready"
      )
        fail();
    }
    receipts.set(id, resolved);
    return resolved;
  }
  for (const id of sources.keys()) body(id);
  for (const batch of batches) {
    const messages: RecoveryGmailBatchProof["batches"][number]["messages"] = [];
    for (const snapshot of batch.snapshots) {
      const messageId = snapshot.rawMessage.id;
      const path = `email-intake/${batch.accountSha256}/messages/${sha256(messageId)}`;
      if (!files.has("operator/" + path + "/capture.json")) {
        if (
          files.has("operator/" + path + "/message.eml") ||
          directories.has("operator/" + path)
        )
          fail();
        messages.push({ messageId, status: "pending" });
        continue;
      }
      const manifest = capture(batch.accountSha256, messageId);
      const receipt = receipts.get(String(manifest.receiptId));
      const source =
        receipt &&
        retained(
          `email-intake/${receipt.accountSha256}/bodies/${receipt.receiptId}/source.txt`
        );
      if (
        !receipt ||
        !source ||
        receipt.accountSha256 !== batch.accountSha256 ||
        receipt.editionId !== batch.expectedEditionId ||
        manifest.sourceSha256 !== receipt.sourceSha256 ||
        manifest.rawSha256 !==
          sha256(Buffer.from(snapshot.rawMessage.raw, "base64url")) ||
        manifest.receivedAtEpochMs !== snapshot.fullMessage.internal_date ||
        !selectSteveEmailPlaintext(snapshot.fullMessage.payload).source.equals(
          source
        )
      )
        fail();
      messages.push({
        messageId,
        status: "captured",
        receiptId: receipt.receiptId,
        disposition: receipt.disposition,
      });
    }
    result.batches.push({ batch, messages });
  }
  return result;
}
