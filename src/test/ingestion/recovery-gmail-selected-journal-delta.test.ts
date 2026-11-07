import { reconstructSelectedLoadAcquiredIntentJournal } from "../../lib/ingestion/recovery-gmail-selected-acquired-intent-journal.js";
import { observeSelectedLoadCompletedJournal } from "../../lib/ingestion/recovery-gmail-selected-completed-journal.js";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailSelectedLoadFixture } from "./fixtures/recovery-gmail-selected-load-fixture.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "../../lib/ingestion/recovery-gmail-selected-load-proof.js";
import { signSelectedLoadExecutionBaseline } from "../../lib/ingestion/recovery-gmail-execution-baseline.js";
import { reconstructSelectedLoadResumeJournal } from "../../lib/ingestion/recovery-gmail-selected-resume-journal.js";
import { proveSelectedLoadJournalDelta } from "../../lib/ingestion/recovery-gmail-selected-journal-delta.js";
import {
  createSelectedGmailLoadEffectPlan,
  selectedGmailLoadEvidence,
} from "../../lib/ingestion/recovery-gmail-selected-load-effects.js";
import { validateWeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import {
  transitionWeeklyRun,
  type WeeklyRunStage,
} from "../../lib/ingestion/weekly-run-state.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
vi.setConfig({ testTimeout: 90000 });
it("proves the committed first-attempt journal and rejects unrelated or missing evidence", async () => {
  const fixture = await createRecoveryGmailSelectedLoadFixture({
    firstBody:
      "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 2026 Delta Band at Test Room, Oakland a/a $20 8pm\n",
  });
  try {
    const baseline = fixture.baseline,
      proof = proveRecoveryGmailSelectedLoadBaseline(baseline),
      source = baseline.checkpoint.files.find((item) =>
        item.path.endsWith(
          "/bodies/" + baseline.selector.receiptId + "/source.txt"
        )
      )!;
    const raw = Buffer.from(source.bytes!, "base64"),
      now = Date.now(),
      binding = {
        admissionSha256: "a".repeat(64),
        evidenceSha256: "b".repeat(64),
        physicalSnapshotSha256: "c".repeat(64),
      };
    const executionBaseline = signSelectedLoadExecutionBaseline(
      { ...binding, generation: 1, startedAtEpochMs: now, entries: [] },
      baseline.recoveryKey
    );
    const original = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(baseline.current.journal, "base64")
    );
    const encode = (snapshot: typeof original) => {
      const { digest: _digest, ...body } = snapshot;
      return Buffer.from(
        canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
      );
    };
    const common = {
      baseline,
      ...binding,
      executionBaseline,
      raw,
      observedGeneration: 1,
      observedLedger: baseline.checkpoint.ledger,
      observedJournal: encode(original),
    };
    expect(proveSelectedLoadJournalDelta(common)).toMatchObject({
      status: "before-run",
      loadAllowed: false,
    });
    const plan = createSelectedGmailLoadEffectPlan(
        baseline.checkpoint,
        proof,
        raw
      ),
      committed = structuredClone(plan.result.ledger),
      run = committed.runs.find(
        (item) => item.runId === plan.receipt.importRunId
      )!;
    run.status = "committed";
    run.committedAtEpochMs = now;
    for (const table of ["artists", "venues"] as const) {
      const ids = new Set(
        baseline.checkpoint.ledger[table].map((item) => item.id)
      );
      for (const item of committed[table])
        if (!ids.has(item.id)) {
          item.createdAtEpochMs = now;
          item.updatedAtEpochMs = now;
        }
    }
    const next = structuredClone(original),
      owner = next.ownership.find(
        (item) => item.scope === "prodigic/zivv/production"
      )!,
      hash = sha256("selected-load/" + binding.admissionSha256);
    owner.owner = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
    owner.fence++;
    owner.expiresAtEpochMs = now + 10000;
    let state = proof.initialState;
    const artifact = (
      stage: WeeklyRunStage,
      attempt: number,
      bytes: Buffer
    ) => ({
      runId: state.runId,
      stage,
      attempt,
      identity: sha256(bytes),
      bytes: bytes.toString("base64"),
    });
    next.stageArtifacts.push(artifact("acquire", 0, raw));
    const contents: Record<string, Buffer> = {
      acquire: raw,
      prepare: Buffer.from(canonicalJson(plan.context) + "\n"),
      reconcile: Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          receipt: plan.receipt,
          report: plan.result.report,
          preflightContext: plan.context,
        }) + "\n"
      ),
    };
    for (const stage of ["acquire", "prepare", "reconcile"] as const) {
      state = transitionWeeklyRun(
        state,
        state.revision,
        stage,
        { status: "running" },
        now
      );
      next.stageArtifacts.push(artifact(stage, 1, contents[stage]!));
      state = transitionWeeklyRun(
        state,
        state.revision,
        stage,
        {
          status: "succeeded",
          evidence: selectedGmailLoadEvidence(
            plan,
            proof.source,
            stage,
            committed
          ),
        },
        now
      );
    }
    state = transitionWeeklyRun(
      state,
      state.revision,
      "load",
      { status: "running" },
      now
    );
    next.runState.push({
      id: state.runId,
      scope: "prodigic/zivv/production",
      revision: state.revision,
      payload: canonicalJson(state),
    });
    next.runState.sort((a, b) => a.id.localeCompare(b.id));
    next.stageArtifacts.sort((a, b) =>
      (
        a.runId +
        "\0" +
        a.stage +
        "\0" +
        String(a.attempt).padStart(16, "0")
      ).localeCompare(
        b.runId + "\0" + b.stage + "\0" + String(b.attempt).padStart(16, "0")
      )
    );
    const evidence = {
      ...common,
      observedGeneration: 2,
      observedLedger: committed,
      observedJournal: encode(next),
    };
    expect(proveSelectedLoadJournalDelta(evidence)).toMatchObject({
      status: "committed",
      runId: state.runId,
      loadAllowed: false,
    });
    const resumed = structuredClone(next);
    const resumedOwner = resumed.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    )!;
    resumedOwner.fence++;
    resumedOwner.expiresAtEpochMs = 0;
    const resumedState = transitionWeeklyRun(
      state,
      state.revision,
      "load",
      {
        status: "succeeded",
        evidence: selectedGmailLoadEvidence(
          plan,
          proof.source,
          "load",
          committed
        ),
      },
      now
    );
    const resumedRow = resumed.runState.find(
      (item) => item.id === state.runId
    )!;
    resumedRow.revision = resumedState.revision;
    resumedRow.payload = canonicalJson(resumedState);
    resumed.stageArtifacts.push(
      artifact("load", 1, Buffer.from("load artifact"))
    );
    resumed.stageArtifacts.sort((a, b) =>
      (
        a.runId +
        "\0" +
        a.stage +
        "\0" +
        String(a.attempt).padStart(16, "0")
      ).localeCompare(
        b.runId + "\0" + b.stage + "\0" + String(b.attempt).padStart(16, "0")
      )
    );
    const intent = {
      kind: "zivv-selected-load-resume-intent" as const,
      version: 2 as const,
      snapshotEvidence: null,
      ...binding,
      executionBaselineSha256: sha256(executionBaseline),
      journalSha256: sha256(encode(next)),
      inventorySha256: "d".repeat(64),
      ledgerRevision: "e".repeat(64),
      generation: 2,
      previousOwner: { ...owner },
      fence: resumedOwner.fence,
      owner: resumedOwner.owner,
      startedAtEpochMs: now + 10000,
      deadlineEpochMs: now + 190000,
    };
    const acquiredOnly = structuredClone(next);
    Object.assign(
      acquiredOnly.ownership.find(
        (item) => item.scope === "prodigic/zivv/production"
      )!,
      {
        owner: intent.owner,
        fence: intent.fence,
        expiresAtEpochMs: intent.startedAtEpochMs + 1000,
      }
    );
    const acquiredProof = reconstructSelectedLoadAcquiredIntentJournal({
      observedJournal: encode(acquiredOnly),
      intent,
    });
    expect(acquiredProof.previousJournal.equals(encode(next))).toBe(true);
    expect(acquiredProof.loadAllowed).toBe(false);
    for (const bad of [
      {
        ...acquiredOnly.ownership.find(
          (item) => item.scope === "prodigic/zivv/production"
        )!,
        fence: intent.fence + 1,
      },
      {
        ...acquiredOnly.ownership.find(
          (item) => item.scope === "prodigic/zivv/production"
        )!,
        expiresAtEpochMs: intent.deadlineEpochMs + 1,
      },
      {
        ...acquiredOnly.ownership.find(
          (item) => item.scope === "prodigic/zivv/production"
        )!,
        owner: "00000000-0000-0000-0000-000000000000",
      },
    ]) {
      const changed = structuredClone(acquiredOnly);
      Object.assign(
        changed.ownership.find((item) => item.scope === bad.scope)!,
        bad
      );
      expect(() =>
        reconstructSelectedLoadAcquiredIntentJournal({
          observedJournal: encode(changed),
          intent,
        })
      ).toThrow();
    }
    const changedBody = structuredClone(acquiredOnly);
    changedBody.stageArtifacts.pop();
    expect(() =>
      reconstructSelectedLoadAcquiredIntentJournal({
        observedJournal: encode(changedBody),
        intent,
      })
    ).toThrow();
    const reconstructed = reconstructSelectedLoadResumeJournal({
      completedJournal: encode(resumed),
      intent,
      runId: state.runId,
    });
    expect(reconstructed.equals(encode(next))).toBe(true);
    const priorWithArtifact = structuredClone(next);
    priorWithArtifact.stageArtifacts = structuredClone(resumed.stageArtifacts);
    const reconstructedWithArtifact = reconstructSelectedLoadResumeJournal({
      completedJournal: encode(resumed),
      intent: { ...intent, journalSha256: sha256(encode(priorWithArtifact)) },
      runId: state.runId,
    });
    expect(reconstructedWithArtifact.equals(encode(priorWithArtifact))).toBe(
      true
    );
    expect(
      proveSelectedLoadJournalDelta({
        ...evidence,
        observedJournal: reconstructed,
      })
    ).toMatchObject({ status: "committed" });
    expect(() =>
      reconstructSelectedLoadResumeJournal({
        completedJournal: encode(resumed),
        intent: { ...intent, journalSha256: "f".repeat(64) },
        runId: state.runId,
      })
    ).toThrow();
    const expired = structuredClone(resumed);
    expired.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    )!.expiresAtEpochMs = now - 1;
    const observedExpired = observeSelectedLoadCompletedJournal(
      encode(expired),
      intent
    );
    expect(observedExpired.lease.status).toBe("expired");
    expect(observedExpired.releasedJournal.equals(encode(resumed))).toBe(true);
    expect(observedExpired.guardedJournalSha256).toBe(sha256(encode(expired)));
    const released = observeSelectedLoadCompletedJournal(
      encode(resumed),
      intent
    );
    expect(released.lease.status).toBe("released");
    expect(released.guardedJournalSha256).toBeNull();
    const stillHeld = structuredClone(resumed);
    stillHeld.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    )!.expiresAtEpochMs = now + 20000;
    expect(() =>
      observeSelectedLoadCompletedJournal(encode(stillHeld), intent)
    ).toThrow("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
    expect(() =>
      reconstructSelectedLoadResumeJournal({
        completedJournal: encode(stillHeld),
        intent,
        runId: state.runId,
      })
    ).toThrow();
    const missing = structuredClone(next);
    missing.stageArtifacts = missing.stageArtifacts.filter(
      (row) => !(row.runId === state.runId && row.stage === "reconcile")
    );
    expect(() =>
      proveSelectedLoadJournalDelta({
        ...evidence,
        observedJournal: encode(missing),
      })
    ).toThrow();
    const changedArtifact = structuredClone(next);
    const review = changedArtifact.stageArtifacts.find(
      (row) => row.runId === state.runId && row.stage === "reconcile"
    )!;
    const changedBytes = Buffer.from("different evidence");
    review.bytes = changedBytes.toString("base64");
    review.identity = sha256(changedBytes);
    expect(() =>
      proveSelectedLoadJournalDelta({
        ...evidence,
        observedJournal: encode(changedArtifact),
      })
    ).toThrow();
    const changedSource = structuredClone(next);
    changedSource.intakeEvidence.pop();
    expect(() =>
      proveSelectedLoadJournalDelta({
        ...evidence,
        observedJournal: encode(changedSource),
      })
    ).toThrow();
    const drift = structuredClone(next);
    drift.ownership.find((item) => item.scope === "prodigic/zivv/production")!
      .fence++;
    expect(() =>
      proveSelectedLoadJournalDelta({
        ...evidence,
        observedJournal: encode(drift),
      })
    ).toThrow();
  } finally {
    fixture.cleanup();
  }
});
