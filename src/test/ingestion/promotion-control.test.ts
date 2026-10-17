import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  applyPromotionTransition,
  authorizePromotionDeployment,
  candidatePublicReleaseId,
  claimPromotion,
  createCompletionProof,
  createPromotionControl,
  EMPTY_COMPLETION_TREE,
  parsePromotionControl,
  promotionAttemptId,
  promotionDigest,
  serializePromotionControl,
  validatePromotionAppend,
  validatePromotionControlTransition,
  verifyCompletionProof,
  type CompletionGitObject,
  type PromotionControl,
  type PromotionDeployment,
  type PromotionEvent,
  type PromotionMode,
  type PromotionRequest,
  type PromotionVerification,
} from "../../lib/ingestion/promotion-control.js";
import {
  createPromotionControlFixture,
  PROMOTION_FIXTURE_CHECKS as checks,
  syntheticLegacyPublicSnapshot as legacy,
  syntheticPromotionRequest as request,
} from "./fixtures/promotion-control-fixture.js";

const workflowCommit = "b".repeat(40);
const digest = "c".repeat(64);
const objects = new Map<string, CompletionGitObject>();
beforeEach(() => objects.clear());
function proof(state: PromotionControl, requestId: string) {
  return createCompletionProof(
    state.completionRoot,
    requestId,
    (hash, type) => {
      const item = objects.get(hash);
      if (!item || item.type !== type)
        throw new Error("Missing test completion object");
      return item.bytes;
    }
  );
}
function claim(state: PromotionControl, input: PromotionRequest) {
  return claimPromotion(state, input, proof(state, input.requestId));
}
function step(state: PromotionControl, event: PromotionEvent) {
  const next = applyPromotionTransition(state, event);
  if (next.stateId !== state.stateId) {
    const generated = validatePromotionControlTransition(state, next);
    for (const [hash, object] of generated.objects) objects.set(hash, object);
  }
  return next;
}
function claimed() {
  const fixture = createPromotionControlFixture();
  return claim(fixture.state, fixture.request);
}
function currentAttempt(state: PromotionControl, mode: PromotionMode) {
  return (
    mode === "promote"
      ? state.active!.promotionAttempt
      : state.active!.rollbackAttempt
  )!;
}
function attempt(state: PromotionControl, mode: PromotionMode = "promote") {
  return {
    operationId: state.active!.operationId,
    mode,
    attemptId: currentAttempt(state, mode).attemptId,
  };
}
function intent(
  state: PromotionControl,
  mode: PromotionMode = "promote"
): Extract<PromotionEvent, { type: "dispatch-intent" }> {
  const op = state.active!;
  const attemptNumber =
    (mode === "promote"
      ? op.promotionAttemptNumber
      : op.rollbackAttemptNumber) + 1;
  return {
    type: "dispatch-intent",
    operationId: op.operationId,
    mode,
    attemptNumber,
    workflowCommit,
    expectedRunAttempt: 1,
    attemptId: promotionAttemptId(
      op.operationId,
      mode,
      attemptNumber,
      workflowCommit,
      1
    ),
  };
}
function planned(state = claimed(), mode: PromotionMode = "promote") {
  return step(state, intent(state, mode));
}
function admission(
  state: PromotionControl,
  mode: PromotionMode = "promote"
): Extract<PromotionEvent, { type: "admit-run" }> {
  return {
    type: "admit-run",
    ...attempt(state, mode),
    admission: {
      workflowCommit,
      runId: mode === "promote" ? "101" : "102",
      runAttempt: 1,
    },
  };
}
function admitted(state = planned(), mode: PromotionMode = "promote") {
  return step(state, admission(state, mode));
}
function deployment(
  state: PromotionControl,
  mode: PromotionMode = "promote"
): PromotionDeployment {
  return {
    admission: currentAttempt(state, mode).admission!,
    artifactId: mode === "promote" ? "201" : "202",
    deploymentId: mode === "promote" ? "301" : "302",
  };
}
function deployed(state = admitted(), mode: PromotionMode = "promote") {
  return step(state, {
    type: "deployed",
    ...attempt(state, mode),
    deployment: deployment(state, mode),
  });
}
function verification(
  state: PromotionControl,
  mode: PromotionMode = "promote"
): PromotionVerification {
  const prior = state.active!.priorVerified;
  const body = {
    destination: state.destination,
    liveUrl: "https://www.prodigic.com/zivv/",
    releaseId:
      mode === "promote"
        ? candidatePublicReleaseId(state.destination, state.active!.request)
        : prior.releaseId,
    inventorySha256:
      mode === "promote"
        ? state.active!.request.publicInventorySha256
        : prior.kind === "legacyPublicSnapshot"
          ? prior.inventorySha256
          : prior.request.publicInventorySha256,
    deployment: deployment(state, mode),
    verifiedAt: "2026-10-14T18:00:00.000Z",
    checks,
  };
  return { ...body, receiptId: promotionDigest(body) };
}
function verificationEvent(
  state: PromotionControl,
  mode: PromotionMode = "promote"
): Extract<PromotionEvent, { type: "verified" }> {
  return {
    type: "verified",
    ...attempt(state, mode),
    verification: verification(state, mode),
    replayProof: null,
  };
}
function verified(state = deployed()) {
  return step(state, verificationEvent(state));
}
function acknowledgementEvent(
  state: PromotionControl
): Extract<PromotionEvent, { type: "acknowledged" }> {
  return {
    type: "acknowledged",
    operationId: state.active!.operationId,
    verificationReceiptId: state.active!.verification!.receiptId,
    acknowledgementId: digest,
    replayProof: null,
  };
}
function acknowledged(state = verified()) {
  return step(state, acknowledgementEvent(state));
}
function failed(state = deployed(), mode: PromotionMode = "promote") {
  return step(state, {
    type: "failed",
    ...attempt(state, mode),
    failureReceiptId: "9".repeat(64),
  });
}
function rehash(value: PromotionControl) {
  const { stateId: _stateId, ...body } = value;
  return { ...body, stateId: promotionDigest(body) };
}
function reseal(value: PromotionVerification) {
  const { receiptId: _receiptId, ...body } = value;
  return { ...body, receiptId: promotionDigest(body) };
}

describe("promotion ownership and bootstrap", () => {
  it.each(["production", "preview"] as const)(
    "claims fixed %s policy and round trips",
    (destination) => {
      const fixture = createPromotionControlFixture(destination);
      const state = claim(fixture.state, fixture.request);
      expect(state.active!.priorVerified.kind).toBe("legacyPublicSnapshot");
      expect(state.revision).toBe(1);
      expect(parsePromotionControl(serializePromotionControl(state))).toEqual(
        state
      );
      expect(
        validatePromotionAppend(null, serializePromotionControl(fixture.state))
          .completionTree
      ).toBe(EMPTY_COMPLETION_TREE);
    }
  );
  it("requires retained nonempty public inventory matched to independent live receipt", () => {
    const snapshot = legacy();
    expect(() => createPromotionControl({ ...snapshot, files: [] })).toThrow();
    expect(() =>
      createPromotionControl({
        ...snapshot,
        verification: { ...snapshot.verification, inventorySha256: digest },
      })
    ).toThrow("legacy observed inventory");
    expect(() =>
      createPromotionControl({
        ...snapshot,
        files: snapshot.files.map((file) => ({ ...file, size: 0 })),
      })
    ).toThrow("Incomplete retained public inventory");
    expect(() =>
      createPromotionControl({
        ...snapshot,
        files: [{ path: "data/ledger.json", size: 10, sha256: digest }],
      })
    ).toThrow("public path");
    expect(() =>
      createPromotionControl({
        ...snapshot,
        verification: {
          ...snapshot.verification,
          checks: { ...checks, cachedClient: false },
        },
      } as unknown as typeof snapshot)
    ).toThrow("Incomplete live verification");
  });
  it("retains immutable owner and rejects competing or changed requests", () => {
    const state = claimed();
    expect(claim(state, state.active!.request)).toEqual(state);
    expect(() => claim(state, request(state, "other"))).toThrow(
      "active owner request"
    );
    for (const change of [
      { payloadCommit: "1".repeat(40) },
      { sourceCommit: "2".repeat(40) },
      { candidateId: "3".repeat(64) },
      { publicInventorySha256: "4".repeat(64) },
      { expectedVerifiedReleaseId: "5".repeat(64) },
    ])
      expect(() =>
        claim(state, { ...state.active!.request, ...change })
      ).toThrow();
  });
  it("rejects stale prior release, purpose spoofing and arbitrary repository/base policy", () => {
    const fixture = createPromotionControlFixture();
    expect(() =>
      claim(fixture.state, {
        ...fixture.request,
        expectedVerifiedReleaseId: digest,
      })
    ).toThrow("prior verified release");
    expect(() =>
      claim(fixture.state, {
        ...fixture.request,
        purpose: "preview",
        basePath: "/zivv-test/",
      })
    ).toThrow("destination base");
    expect(() =>
      claim(fixture.state, { ...fixture.request, basePath: "/custom/" })
    ).toThrow("purpose/base");
    expect(() =>
      claim(fixture.state, { ...fixture.request, requestId: "../private" })
    ).toThrow("request ID");
  });
  it("ancient exact requests replay without reacquiring, changed requests remain rejected", () => {
    const completed = acknowledged();
    const old = proof(completed, "edition-2026-10-16").record!.request;
    const newer = claim(completed, request(completed, "newer"));
    expect(claim(newer, old)).toEqual(newer);
    expect(() =>
      claim(newer, { ...old, payloadCommit: "1".repeat(40) })
    ).toThrow("completed request replay");
    expect(() => claimPromotion(newer, request(newer, "new-request"))).toThrow(
      "reader required"
    );
  });
});

describe("durable dispatch fencing and exact effects", () => {
  it("authorizes only the current admitted run and exact public target", () => {
    const state = admitted();
    const input = {
      ...attempt(state),
      admission: currentAttempt(state, "promote").admission!,
    };
    const permitted = authorizePromotionDeployment(state, input);
    expect(permitted.repository).toBe("prodigic/zivv");
    expect(permitted.publicCommit).toBe(state.active!.request.payloadCommit);
    expect(permitted.candidateId).toBe(state.active!.request.candidateId);
    expect(() =>
      authorizePromotionDeployment(state, {
        ...input,
        admission: { ...input.admission, runId: "999" },
      })
    ).toThrow("authorized admitted run");
    for (const later of [
      deployed(state),
      failed(deployed(state)),
      acknowledged(verified(deployed(state))),
    ])
      expect(() => authorizePromotionDeployment(later, input)).toThrow();
    const rollback = admitted(planned(failed(), "rollback"), "rollback");
    const restore = authorizePromotionDeployment(rollback, {
      ...attempt(rollback, "rollback"),
      admission: currentAttempt(rollback, "rollback").admission!,
    });
    expect(restore.publicCommit).toBe("a".repeat(40));
    expect(restore.candidateId).toBeNull();
    expect(restore.sourceCommit).toBeNull();
    expect(restore.releaseId).toBe(rollback.active!.priorVerified.releaseId);
  });
  it("requires persisted intent and immutable planned workflow/run attempt", () => {
    const state = planned();
    expect(() =>
      step(state, {
        ...admission(state),
        admission: {
          workflowCommit: "a".repeat(40),
          runId: "101",
          runAttempt: 1,
        },
      })
    ).toThrow("reviewed workflow commit");
    expect(() =>
      step(state, {
        ...admission(state),
        admission: { workflowCommit, runId: "101", runAttempt: 2 },
      })
    ).toThrow("planned workflow attempt");
    const noIntent = claimed(),
      marker = intent(noIntent);
    expect(() =>
      step(noIntent, {
        type: "admit-run",
        operationId: marker.operationId,
        mode: "promote",
        attemptId: marker.attemptId,
        admission: { workflowCommit, runId: "101", runAttempt: 1 },
      })
    ).toThrow("Stale dispatch attempt");
  });
  it("holds uncertainty and cannot redispatch until successful CAS fence", () => {
    const pending = planned(),
      old = admission(pending);
    const uncertain = step(pending, {
      type: "dispatch-uncertain",
      ...attempt(pending),
    });
    expect(() => planned(uncertain)).toThrow("transition");
    expect(() => claim(uncertain, request(uncertain, "other"))).toThrow();
    const fenced = step(uncertain, {
      type: "fence-dispatch",
      ...attempt(uncertain),
      fenceReceiptId: digest,
    });
    expect(() => step(fenced, old)).toThrow("transition");
    const retry = planned(fenced);
    expect(retry.active!.promotionAttemptNumber).toBe(2);
    expect(() => step(retry, old)).toThrow("Stale dispatch attempt");
    expect(admitted(retry).active!.phase).toBe("admitted");
  });
  it.each([admitted, deployed, verified])(
    "never fences or retries an admitted effect",
    (stage) => {
      const state = stage();
      expect(() =>
        step(state, {
          type: "fence-dispatch",
          ...attempt(state),
          fenceReceiptId: digest,
        })
      ).toThrow("transition");
      expect(() => planned(state)).toThrow("transition");
    }
  );
  it("reconciles exact admission, deployment and intent while rejecting changed effect IDs", () => {
    const pending = planned(),
      event = admission(pending),
      state = step(pending, event);
    expect(step(state, event)).toEqual(state);
    expect(() =>
      step(state, { ...event, admission: { ...event.admission, runId: "999" } })
    ).toThrow("run admission replay");
    const effect = {
      type: "deployed" as const,
      ...attempt(state),
      deployment: deployment(state),
    };
    const live = step(state, effect);
    expect(step(live, effect)).toEqual(live);
    expect(() =>
      step(live, {
        ...effect,
        deployment: { ...effect.deployment, deploymentId: "999" },
      })
    ).toThrow("deployment replay");
    expect(() =>
      step(state, {
        ...effect,
        deployment: {
          ...effect.deployment,
          admission: { ...effect.deployment.admission, runId: "999" },
        },
      })
    ).toThrow("deployment admitted run");
  });
  it("requires positive planned attempts and derived immutable dispatch IDs", () => {
    const state = claimed(),
      event = intent(state);
    expect(() => step(state, { ...event, attemptId: digest })).toThrow(
      "dispatch attempt identity"
    );
    expect(() => step(state, { ...event, attemptNumber: 2 })).toThrow(
      "next dispatch attempt"
    );
    expect(() => step(state, { ...event, expectedRunAttempt: 0 })).toThrow(
      "attempt number"
    );
    expect(() =>
      step(planned(), {
        ...admission(planned()),
        admission: { workflowCommit, runId: "01", runAttempt: 1 },
      })
    ).toThrow("GitHub effect identity");
  });
});

describe("live verification, acknowledgement and public rollback", () => {
  it("advances verified bytes only on exact live evidence and retains owner for acknowledgement", () => {
    const live = deployed();
    expect(live.lastVerified.kind).toBe("legacyPublicSnapshot");
    const success = verified(live);
    expect(success.lastVerified.kind).toBe("candidateRelease");
    expect(success.active!.phase).toBe("verified");
    expect(() => claim(success, request(success, "other"))).toThrow();
    const completed = acknowledged(success);
    expect(completed.active).toBeNull();
    expect(completed.completedCount).toBe(1);
    expect(proof(completed, "edition-2026-10-16").record!.outcome).toBe(
      "acknowledged"
    );
  });
  it("resumes only acknowledgement after live success, including exact late completion replay", () => {
    const success = verified(),
      event = acknowledgementEvent(success);
    expect(step(success, success.lastTransition.event)).toEqual(success);
    expect(() => planned(success)).toThrow("transition");
    expect(() => failed(success)).toThrow("transition");
    const completed = step(success, event),
      replay = {
        ...event,
        replayProof: proof(completed, success.active!.request.requestId),
      };
    expect(step(completed, replay)).toEqual(completed);
    expect(() =>
      step(completed, { ...replay, acknowledgementId: "8".repeat(64) })
    ).toThrow("completed acknowledgement replay");
    expect(() => step(deployed(), event)).toThrow("transition");
  });
  it.each([
    "releaseId",
    "inventorySha256",
    "destination",
    "deploymentId",
    "artifactId",
    "runId",
  ])("rejects rehashed mismatching %s receipt", (field) => {
    const state = deployed(),
      original = verification(state);
    const changed = { ...original };
    if (field === "releaseId") changed.releaseId = "7".repeat(64);
    if (field === "inventorySha256") changed.inventorySha256 = "8".repeat(64);
    if (field === "destination") {
      changed.destination = "preview";
      changed.liveUrl = "https://www.prodigic.com/zivv-test/";
    }
    if (field === "deploymentId")
      changed.deployment = { ...original.deployment, deploymentId: "999" };
    if (field === "artifactId")
      changed.deployment = { ...original.deployment, artifactId: "999" };
    if (field === "runId")
      changed.deployment = {
        ...original.deployment,
        admission: { ...original.deployment.admission, runId: "999" },
      };
    expect(() =>
      step(state, {
        ...verificationEvent(state),
        verification: reseal(changed),
      })
    ).toThrow("Promotion mismatch");
  });
  it("retains failure ownership until previous public bytes match a new rollback deployment", () => {
    const failure = failed();
    expect(failure.active!.phase).toBe("rollback-required");
    expect(() => claim(failure, request(failure, "other"))).toThrow();
    expect(() => planned(failure)).toThrow("transition");
    const rollback = deployed(
      admitted(planned(failure, "rollback"), "rollback"),
      "rollback"
    );
    const event = verificationEvent(rollback, "rollback");
    expect(() =>
      step(rollback, {
        ...event,
        verification: reseal({
          ...event.verification,
          releaseId: candidatePublicReleaseId(
            rollback.destination,
            rollback.active!.request
          ),
        }),
      })
    ).toThrow("verified public release");
    const completed = step(rollback, event);
    expect(completed.active).toBeNull();
    expect(completed.lastVerified).toEqual(failure.active!.priorVerified);
    expect(
      proof(completed, failure.active!.request.requestId).record!.verification
        .deployment.deploymentId
    ).toBe("302");
  });
  it("holds failed rollback and fences old attempts after an explicit new intent", () => {
    const rollback = deployed(
        admitted(planned(failed(), "rollback"), "rollback"),
        "rollback"
      ),
      old = attempt(rollback, "rollback");
    const failure = failed(rollback, "rollback");
    expect(failure.active!.phase).toBe("rollback-required");
    expect(failure.active!.rollbackAttempt!.status).toBe("failed");
    const retry = planned(failure, "rollback");
    expect(retry.active!.rollbackAttemptNumber).toBe(2);
    expect(() =>
      step(retry, {
        type: "deployed",
        ...old,
        deployment: deployment(rollback, "rollback"),
      })
    ).toThrow("Stale dispatch attempt");
  });
  it("rejects stale rollback and changed terminal attempt even with exact live receipt", () => {
    const rollback = deployed(
      admitted(planned(failed(), "rollback"), "rollback"),
      "rollback"
    );
    const event = verificationEvent(rollback, "rollback"),
      completed = step(rollback, event);
    const newer = claim(completed, request(completed, "newer"));
    const replay = {
      ...event,
      replayProof: proof(newer, rollback.active!.request.requestId),
    };
    expect(step(newer, replay)).toEqual(newer);
    expect(() => step(newer, { ...replay, attemptId: "1".repeat(64) })).toThrow(
      "completed rollback attempt"
    );
    expect(() =>
      step(newer, {
        ...replay,
        verification: reseal({
          ...event.verification,
          verifiedAt: "2026-10-15T18:00:00.000Z",
        }),
      })
    ).toThrow("completed rollback verification");
  });
  it("rolls subsequent failures back to the prior candidate public release", () => {
    const published = acknowledged();
    const newer = claim(published, {
      ...request(published, "next"),
      candidateId: "1".repeat(64),
      payloadCommit: "2".repeat(40),
    });
    const rollback = deployed(
      admitted(
        planned(failed(deployed(admitted(planned(newer)))), "rollback"),
        "rollback"
      ),
      "rollback"
    );
    const completed = step(rollback, verificationEvent(rollback, "rollback"));
    expect(completed.lastVerified).toEqual(published.lastVerified);
    expect(JSON.stringify(completed)).not.toContain("ledgerRevision");
  });
});

describe("bounded native Git completion index and strict append validation", () => {
  it.each(["40000 ../private", "100644 a", "40000 aa"])(
    "rejects natively hashed malformed tree entry %s",
    (header) => {
      const bytes = Buffer.concat([
        Buffer.from(header + "\0", "ascii"),
        Buffer.from("a".repeat(40), "hex"),
      ]);
      const objectId = createHash("sha1")
        .update("tree " + bytes.length + "\0")
        .update(bytes)
        .digest("hex");
      expect(() =>
        createCompletionProof(objectId, "request", () => bytes)
      ).toThrow("Unsupported completion Git tree entry");
    }
  );
  it("requires full canonical proof paths and binds leaf to exact request", () => {
    const completed = acknowledged(),
      valid = proof(completed, "edition-2026-10-16");
    expect(
      verifyCompletionProof(
        completed.completionRoot,
        "edition-2026-10-16",
        valid
      )!.request.requestId
    ).toBe("edition-2026-10-16");
    expect(() =>
      verifyCompletionProof(completed.completionRoot, "other", valid)
    ).toThrow("completion lookup key");
    expect(() =>
      verifyCompletionProof(completed.completionRoot, "edition-2026-10-16", {
        ...valid,
        levels: valid.levels.slice(1),
      })
    ).toThrow("64 bounded levels");
    expect(() =>
      verifyCompletionProof(completed.completionRoot, "edition-2026-10-16", {
        ...valid,
        record: null,
      })
    ).toThrow("completion proof root");
    const absent = proof(completed, "never-dispatched");
    expect(absent.record).toBeNull();
    expect(() =>
      verifyCompletionProof(completed.completionRoot, "never-dispatched", {
        ...absent,
        levels: absent.levels.map(() => []),
      })
    ).toThrow("completion proof root");
  });
  it("rejects corrupt, missing and private-path native index objects", () => {
    const completed = acknowledged();
    expect(() =>
      createCompletionProof(
        completed.completionRoot,
        "edition-2026-10-16",
        () => Buffer.from("corrupt")
      )
    ).toThrow("object hash mismatch");
    expect(() =>
      createCompletionProof(
        completed.completionRoot,
        "edition-2026-10-16",
        () => {
          throw new Error("missing");
        }
      )
    ).toThrow("missing");
    const valid = proof(completed, "never-dispatched");
    expect(() =>
      verifyCompletionProof(completed.completionRoot, "never-dispatched", {
        ...valid,
        levels: valid.levels.map((level, index) =>
          index === 0
            ? [{ name: "../private", objectId: "a".repeat(40) }]
            : level
        ),
      })
    ).toThrow("sibling name");
  });
  it("rejects rehashed impossible projections and arbitrary metadata", () => {
    const state = admitted();
    for (const change of [
      { destination: "preview" as const },
      { active: { ...state.active!, phase: "verified" as const } },
      {
        active: {
          ...state.active!,
          request: { ...state.active!.request, payloadCommit: "1".repeat(40) },
        },
      },
    ])
      expect(() =>
        parsePromotionControl(rehash({ ...state, ...change }))
      ).toThrow();
    expect(() =>
      parsePromotionControl({ ...state, privatePath: "C:/key" })
    ).toThrow("schema fields");
    expect(() =>
      step(state, { ...intent(state), privatePath: "C:/key" } as PromotionEvent)
    ).toThrow("schema fields");
    expect(() => parsePromotionControl({ ...state, stateId: digest })).toThrow(
      "checksum"
    );
    const forged = rehash({
      ...state,
      lastTransition: {
        ...state.lastTransition,
        event: {
          type: "acknowledged",
          operationId: state.active!.operationId,
          verificationReceiptId: digest,
          acknowledgementId: digest,
          replayProof: null,
        },
      },
    });
    expect(() => parsePromotionControl(forged)).toThrow(
      "acknowledged owner projection"
    );
  });
  it("validates exact legal previous->next event, separately from standalone state checks", () => {
    const before = claimed(),
      after = planned(before);
    validatePromotionAppend(
      serializePromotionControl(before),
      serializePromotionControl(after)
    );
    expect(() =>
      validatePromotionControlTransition(before, admitted(after))
    ).toThrow("append predecessor");
    expect(() => validatePromotionControlTransition(null, before)).toThrow(
      "Initial control"
    );
    const forged = rehash({ ...after, revision: after.revision + 1 });
    expect(parsePromotionControl(forged)).toEqual(forged);
    expect(() => validatePromotionControlTransition(before, forged)).toThrow(
      "legal control append"
    );
    expect(() => validatePromotionControlTransition(before, before)).toThrow(
      "append predecessor"
    );
  });
  it("retains 1,000 weekly completions with bounded control bytes and exact ancient replay", () => {
    let state = createPromotionControl(legacy());
    let oldest: PromotionRequest | null = null;
    let largest = 0;
    for (let index = 0; index < 1000; index++) {
      const input = {
        ...request(state, "weekly-" + index),
        candidateId: promotionDigest(index),
        payloadCommit: promotionDigest("payload-" + index).slice(0, 40),
      };
      oldest ??= input;
      state = claim(state, input);
      largest = Math.max(largest, serializePromotionControl(state).length);
      state = acknowledged(verified(deployed(admitted(planned(state)))));
      largest = Math.max(largest, serializePromotionControl(state).length);
    }
    expect(state.completedCount).toBe(1000);
    expect(largest).toBeLessThan(20000);
    expect(claim(state, oldest!)).toEqual(state);
    expect(() => claim(state, { ...oldest!, candidateId: digest })).toThrow(
      "completed request replay"
    );
    const generated = objects;
    expect(generated.size).toBeGreaterThan(1000);
    expect(JSON.stringify(state)).not.toContain("history");
    expect(JSON.stringify(state)).not.toContain("promotionAttempts");
  }, 60000);
});
