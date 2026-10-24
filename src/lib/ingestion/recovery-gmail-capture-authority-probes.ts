import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertRecoveredGmailCaptureJournal,
  recoveredGmailCaptureAuthorityProbeMode,
} from "./recovery-gmail-capture-admission.js";
import { createRecoveryGmailCaptureProbeControls } from "./recovery-gmail-capture-probe-controls.js";
import { withOperatorRetirementScope } from "./operator-installation.js";
import {
  canonicalJson,
  openStore,
  withStoreTransaction,
  writeSqliteLedger,
} from "./sqlite-store.js";
import {
  captureSteveEmail,
  type PreparedSteveEmailCapture,
  type SteveEmailReceipt,
} from "./steve-email-intake.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
  WeeklyRunJournal,
  type WeeklyRunLease,
} from "./weekly-run-journal.js";

const scopeError = "RECOVERY_GMAIL_CAPTURE_SCOPE_EXCEEDED";
const identityError = "RECOVERY_GMAIL_CAPTURE_LEASE_IDENTITY";
const fencingError = "Expired or fenced weekly run owner";
const nestedGuardError = "Nested guarded journal operation refused";

function fail(code: string): never {
  throw new Error(code);
}

/** Hash the physical prepared tree without following symlinks or opening SQL.
 * The journal is already open under the genuine intake lease. All its physical
 * files, including WAL/SHM, participate; instability cannot produce a pass. */
function physicalSnapshot(root: string): string {
  const entries: unknown[] = [];
  let count = 0,
    total = 0;
  const walk = (directory: string, prefix: string) => {
    const beforeDirectory = lstatSync(directory);
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink())
      fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSAFE");
    for (const name of readdirSync(directory).sort()) {
      if (++count > 50_000)
        fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_CAPACITY");
      const path = join(directory, name),
        relative = prefix + name,
        before = lstatSync(path);
      const identity = {
        path: relative,
        dev: before.dev,
        ino: before.ino,
        nlink: before.nlink,
        mode: before.mode,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      };
      if (before.isSymbolicLink()) {
        entries.push({
          ...identity,
          kind: "symlink",
          target: readlinkSync(path),
        });
      } else if (before.isDirectory()) {
        entries.push({ ...identity, kind: "directory" });
        walk(path, relative + "/");
      } else {
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          (total += before.size) > 512 * 1024 * 1024
        )
          fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSAFE");
        const fd = openSync(path, "r"),
          digest = createHash("sha256"),
          buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        try {
          const opened = fstatSync(fd);
          if (
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size ||
            opened.nlink !== before.nlink
          )
            fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSTABLE");
          for (;;) {
            const length = readSync(fd, buffer, 0, buffer.length, null);
            if (!length) break;
            bytes += length;
            if (bytes > before.size)
              fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSTABLE");
            digest.update(buffer.subarray(0, length));
          }
          const after = fstatSync(fd);
          if (
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.nlink !== before.nlink ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSTABLE");
        } finally {
          closeSync(fd);
        }
        const after = lstatSync(path);
        if (
          bytes !== before.size ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.nlink !== before.nlink ||
          after.isSymbolicLink() ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSTABLE");
        entries.push({
          ...identity,
          kind: "file",
          size: bytes,
          sha256: digest.digest("hex"),
        });
      }
    }
    const afterDirectory = lstatSync(directory);
    if (
      afterDirectory.dev !== beforeDirectory.dev ||
      afterDirectory.ino !== beforeDirectory.ino ||
      afterDirectory.mtimeMs !== beforeDirectory.mtimeMs ||
      afterDirectory.ctimeMs !== beforeDirectory.ctimeMs
    )
      fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSTABLE");
  };
  walk(root, "");
  return createHash("sha256").update(canonicalJson(entries)).digest("hex");
}

/** Pure bounded read-only observation; never establishes an effect scope. */
export { physicalSnapshot as snapshotRecoveryGmailCaptureProbeTree };

/** Fixed compiled probes only. This entry cannot establish capture authority,
 * select arbitrary work, provide callbacks, or bypass any production guard. */
export async function runRecoveryGmailCaptureAuthorityProbes(input: {
  journal: WeeklyRunJournal;
  lease: WeeklyRunLease;
  input: Parameters<typeof captureSteveEmail>[0];
  prepared: PreparedSteveEmailCapture;
  receipt: SteveEmailReceipt;
}): Promise<never> {
  if (
    recoveredGmailCaptureAuthorityProbeMode() !==
      "authority-negatives-before-source" ||
    !(input.journal instanceof WeeklyRunJournal)
  )
    fail(scopeError);
  const { journal, lease, prepared, receipt } = input;
  const operator = resolve(input.input.operatorDirectory),
    root = dirname(operator),
    catalog = join(operator, "ledger.sqlite"),
    controls = createRecoveryGmailCaptureProbeControls();
  if (
    resolve(journal.path) !== join(operator, "weekly-runs.sqlite") ||
    lease.scope !== "prodigic/zivv/production" ||
    receipt.receiptId !== prepared.receiptId ||
    receipt.sourceSha256 !== prepared.sourceSha256 ||
    receipt.messageId !== prepared.messageId
  )
    fail(scopeError);
  assertRecoveredGmailCaptureJournal({ path: journal.path, effect: "read" });
  if (
    canonicalJson(journal.load(controls.seed.runningState.runId)) !==
      canonicalJson(controls.seed.runningState) ||
    journal.readArtifact(controls.seed.runningState.runId, "acquire", 1) !==
      null ||
    journal.load(controls.create.state.runId) !== null ||
    journal.readIntakeEvidence(lease.scope, "source", receipt.receiptId) !==
      null
  )
    fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_CONTROL_MISSING");

  const snapshot = () => {
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(
      input.journal.path
    );
    validateWeeklyJournalRecoverySnapshot(journal);
    return canonicalJson({
      journal: journal.toString("base64"),
      physical: physicalSnapshot(root),
    });
  };
  // Warm the same real readonly connection path before taking a baseline. WAL
  // bookkeeping that does not settle is explicitly inconclusive, never success.
  snapshot();
  if (snapshot() !== snapshot())
    fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_SNAPSHOT_UNSTABLE");
  const verified: string[] = [];
  const deny = async (
    id: string,
    work: () => unknown,
    expected = scopeError
  ) => {
    // IDs are fixed literals below, never caller text or filesystem evidence.
    const diagnostic = id.replaceAll("-", "_").toUpperCase();
    const before = snapshot();
    let observed: unknown;
    try {
      await work();
    } catch (error) {
      observed = error;
    }
    if (snapshot() !== before)
      fail("RECOVERY_GMAIL_CAPTURE_PROBE_STATE_CHANGED_" + diagnostic);
    if (!(observed instanceof Error) || observed.message !== expected)
      fail("RECOVERY_GMAIL_CAPTURE_PROBE_REFUSAL_" + diagnostic);
    verified.push(id);
  };
  await deny("journal-create", () =>
    journal.create(controls.create.state, lease, controls.create.rawSource)
  );
  await deny("journal-save", () =>
    journal.save(
      controls.seed.succeededState,
      controls.seed.runningState.revision,
      lease
    )
  );
  await deny("journal-artifact", () =>
    journal.writeArtifact(
      controls.seed.runningState.runId,
      "acquire",
      controls.artifactBytes,
      lease
    )
  );
  await deny("journal-export-unguarded", () =>
    journal.exportRecoverySnapshot(lease)
  );
  const restore = readWeeklyJournalRecoverySnapshotReadOnly(journal.path);
  validateWeeklyJournalRecoverySnapshot(restore);
  await deny("journal-restore", () => journal.restoreRecoverySnapshot(restore));
  await deny(
    "journal-acquire-other-scope",
    () => journal.acquire("prodigic/zivv/preview"),
    identityError
  );
  const wrongOwner = {
      ...lease,
      owner:
        lease.owner === "11111111-1111-4111-8111-111111111111"
          ? "22222222-2222-4222-8222-222222222222"
          : "11111111-1111-4111-8111-111111111111",
    },
    wrongFence = { ...lease, fence: lease.fence + 1 };
  let callbackEntered = false;
  const forbiddenWork = async () => {
    callbackEntered = true;
  };
  await deny(
    "journal-guard-wrong-owner",
    () => journal.guardOperation(wrongOwner, forbiddenWork),
    identityError
  );
  await deny(
    "journal-guard-wrong-fence",
    () => journal.guardOperation(wrongFence, forbiddenWork),
    identityError
  );
  // These two are ordinary fencing controls, not evidence of the Gmail gate:
  // assertLease intentionally precedes the inner renew/release effect hook.
  await deny(
    "journal-renew-ordinary-fencing",
    () => journal.renew(wrongOwner),
    fencingError
  );
  await deny(
    "journal-release-ordinary-fencing",
    () => journal.release(wrongFence),
    fencingError
  );
  await deny("catalog-open-existing", () => {
    const db = openStore(catalog, false);
    db.close();
  });
  await deny("catalog-open-create", () => {
    const db = openStore(catalog, true);
    db.close();
  });
  await deny("catalog-transaction", () =>
    withStoreTransaction(catalog, forbiddenWork)
  );
  await deny("catalog-write-existing-entry", () =>
    writeSqliteLedger(catalog, controls.catalogLedger)
  );
  await deny("catalog-write-create", () =>
    writeSqliteLedger(
      join(operator, "authority-probe-catalog.sqlite"),
      controls.catalogLedger,
      true
    )
  );
  const { runWeeklyImport } = await import("./weekly-import-runner.js");
  await deny("weekly-import", () =>
    runWeeklyImport({
      root: join(root, "checkout"),
      source: {
        editionId: prepared.editionId,
        deliveryId: prepared.deliveryId,
        raw: prepared.source,
        importObservedAtEpochMs: receipt.firstObservedAtEpochMs,
      },
      stopAfter: "load",
    })
  );
  await deny("retirement-entry", () =>
    withOperatorRetirementScope(operator, forbiddenWork)
  );
  await deny("intake-nested", () => captureSteveEmail(input.input));
  // Windows byte-range locks prohibit flat SQLite/WAL/SHM reads during the
  // allowed BEGIN IMMEDIATE. Keep the full physical comparison outside it;
  // inside, use only the journal's intentional matching-lease borrowed read.
  const beforeGuard = snapshot();
  await journal.guardOperation(lease, async () => {
    const before = journal.exportRecoverySnapshot(lease);
    let observed: unknown;
    try {
      await journal.guardOperation(lease, forbiddenWork);
    } catch (error) {
      observed = error;
    }
    if (!journal.exportRecoverySnapshot(lease).equals(before))
      fail("RECOVERY_GMAIL_CAPTURE_PROBE_STATE_CHANGED_JOURNAL_GUARD_NESTED");
    if (!(observed instanceof Error) || observed.message !== nestedGuardError)
      fail("RECOVERY_GMAIL_CAPTURE_PROBE_REFUSAL_JOURNAL_GUARD_NESTED");
  });
  if (snapshot() !== beforeGuard)
    fail("RECOVERY_GMAIL_CAPTURE_PROBE_STATE_CHANGED_JOURNAL_GUARD_NESTED");
  verified.push("journal-guard-nested");
  if (callbackEntered || verified.length !== 19)
    fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_PROBE_INCOMPLETE");
  fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_NEGATIVES_VERIFIED");
}
