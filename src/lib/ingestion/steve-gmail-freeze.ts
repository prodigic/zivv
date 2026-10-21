import { dirname, resolve } from "node:path";
import { readAuthenticatedSteveGmailBatches } from "./steve-gmail-handoff.js";
import {
  resolveRetainedSteveEmailMessages,
  selectSteveEmailPlaintext,
} from "./steve-email-intake.js";
import { sha256 } from "./steve-preflight.js";
import type { WeeklyRunJournal } from "./weekly-run-journal.js";

const scope = "prodigic/zivv/production";
class SteveGmailFreezeError extends Error {
  readonly code = "PENDING_STEVE_EMAIL_INTAKE";
  constructor() {
    super("PENDING_STEVE_EMAIL_INTAKE");
    this.name = "SteveGmailFreezeError";
  }
}
function fail(): never {
  throw new SteveGmailFreezeError();
}

/**
 * Read-only freeze gate, called inside the existing production lease/guard.
 * Batch registration time selects obligations; it never backdates admission.
 */
export function assertNoPendingSteveGmailBatches(input: {
  operatorDirectory: string;
  journal: WeeklyRunJournal;
  scope: string;
  cutoffEpochMs: number;
}): void {
  try {
    if (
      input.scope !== scope ||
      resolve(dirname(input.journal.path)) !==
        resolve(input.operatorDirectory) ||
      !Number.isSafeInteger(input.cutoffEpochMs) ||
      input.cutoffEpochMs < 0 ||
      input.cutoffEpochMs > Date.now()
    )
      fail();
    // The reader returns immediately for absent/artifact-empty storage, without
    // requiring a key. It authenticates all present batches and staging first.
    const batches = readAuthenticatedSteveGmailBatches({
      operatorDirectory: input.operatorDirectory,
    });
    for (const batch of batches) {
      if (batch.firstSavedAtEpochMs >= input.cutoffEpochMs) continue;
      const messages = batch.snapshots.map((snapshot) => ({
        messageId: snapshot.rawMessage.id,
        rawSha256: sha256(Buffer.from(snapshot.rawMessage.raw, "base64url")),
      }));
      const retained = resolveRetainedSteveEmailMessages({
        operatorDirectory: input.operatorDirectory,
        accountId: batch.accountId,
        expectedEditionId: batch.expectedEditionId,
        messages,
      });
      if (retained.length !== messages.length) fail();
      const byMessage = new Map(retained.map((item) => [item.messageId, item]));
      if (byMessage.size !== messages.length) fail();
      for (const snapshot of batch.snapshots) {
        const item = byMessage.get(snapshot.rawMessage.id);
        if (!item || item.status !== "captured") fail();
        const { receipt, source } = item;
        if (
          receipt.accountSha256 !== batch.accountSha256 ||
          receipt.editionId !== batch.expectedEditionId ||
          receipt.disposition !== "ready" ||
          item.captureReceivedAtEpochMs !==
            snapshot.fullMessage.internal_date ||
          sha256(source) !== receipt.sourceSha256 ||
          !source.equals(
            selectSteveEmailPlaintext(snapshot.fullMessage.payload).source
          )
        )
          fail();
        // The duplicate-message mapping may select an older body receipt; its
        // original message ID/raw hash/received time need not match this item.
        const registered = input.journal.readIntakeEvidence(
          scope,
          "source",
          receipt.receiptId
        );
        if (!registered) fail();
        const original = JSON.parse(registered.toString("utf8")) as Record<
          string,
          unknown
        >;
        for (const field of [
          "receiptId",
          "accountSha256",
          "editionId",
          "deliveryId",
          "sourceSha256",
          "firstObservedAtEpochMs",
        ] as const)
          if (original[field] !== receipt[field]) fail();
        if (
          !input.journal
            .findDelivery(scope, receipt.editionId, receipt.deliveryId)
            .some(
              (run) =>
                run.source.editionId === receipt.editionId &&
                run.source.deliveryId === receipt.deliveryId &&
                run.source.rawSha256 === receipt.sourceSha256 &&
                run.source.importObservedAtEpochMs ===
                  receipt.firstObservedAtEpochMs &&
                run.stages.find((stage) => stage.stage === "load")?.status ===
                  "succeeded"
            )
        )
          fail();
      }
    }
  } catch {
    // Preserve the existing freeze blocked-state contract and redact internals.
    fail();
  }
}
