import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRemotePromotionControlStore,
  createBareTestPromotionControlTransport,
  type PromotionControlStore,
} from "../../lib/ingestion/promotion-control-git.js";
import {
  applyPromotionTransition,
  candidatePublicReleaseId,
  claimPromotion,
  createCompletionProof,
  parsePromotionControl,
  promotionAttemptId,
  promotionDigest,
  serializePromotionControl,
  validatePromotionAppend,
  PROMOTION_DESTINATIONS,
  type PromotionControl,
  type PromotionEvent,
} from "../../lib/ingestion/promotion-control.js";
import {
  createPromotionControlFixture,
  PROMOTION_FIXTURE_CHECKS,
  syntheticPromotionRequest,
} from "./fixtures/promotion-control-fixture.js";

describe("real promotion protocol and remote Git integration", () => {
  it("fences stale owners/attempts and retains terminal replay proofs through remote GC and fresh recovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "zivv-promotion-integrated-"));
    const repositoryRoot = join(directory, "source"),
      remote = join(directory, "remote.git");
    const git = (root: string, args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    try {
      mkdirSync(repositoryRoot);
      git(repositoryRoot, ["init", "--quiet"]);
      git(repositoryRoot, [
        "remote",
        "add",
        "origin",
        "https://github.com/prodigic/zivv.git",
      ]);
      git(directory, ["init", "--bare", "--quiet", remote]);
      const transport = createBareTestPromotionControlTransport(
        repositoryRoot,
        remote
      );
      const create = () =>
        createRemotePromotionControlStore({
          repositoryRoot,
          destination: "production",
          transport,
          validateState: (bytes, destination) => {
            const state = parsePromotionControl(bytes);
            if (state.destination !== destination)
              throw new Error("Wrong destination");
            return state.completionRoot;
          },
          validateTransition: validatePromotionAppend,
        });
      let store: PromotionControlStore = create();
      let head: string | null = null;
      const { state: bootstrap, request } = createPromotionControlFixture();
      let current: PromotionControl = bootstrap;
      const append = (next: PromotionControl) => {
        const intent = {
          expectedHead: head,
          bytes: serializePromotionControl(next),
          createdAt: "2026-10-14T23:00:00.000Z",
        };
        const prepared = store.prepareAppend(intent);
        expect(store.compareAndAppend(intent)).toMatchObject({
          status: "appended",
          attemptedHead: prepared.attemptedHead,
        });
        head = prepared.attemptedHead;
        current = next;
      };
      const transition = (event: PromotionEvent) =>
        append(applyPromotionTransition(current, event));
      const preparedBootstrap = store.prepareAppend({
        expectedHead: null,
        bytes: serializePromotionControl(bootstrap),
        createdAt: "2026-10-14T23:00:00.000Z",
      });
      expect(store.read().head).toBe(null);
      append(bootstrap);
      expect(head).toBe(preparedBootstrap.attemptedHead);
      const bootstrapHead = head;
      const competing = claimPromotion(
        bootstrap,
        syntheticPromotionRequest(bootstrap, "competing-edition")
      );
      append(claimPromotion(current, request));
      expect(
        store.compareAndAppend({
          expectedHead: bootstrapHead,
          bytes: serializePromotionControl(competing),
          createdAt: "2026-10-14T23:00:00.000Z",
        }).status
      ).toBe("conflict");
      const operationId = current.active!.operationId,
        workflowCommit = "b".repeat(40);
      const dispatch = (
        number: number
      ): Extract<PromotionEvent, { type: "dispatch-intent" }> => ({
        type: "dispatch-intent",
        operationId,
        mode: "promote",
        attemptNumber: number,
        attemptId: promotionAttemptId(
          operationId,
          "promote",
          number,
          workflowCommit,
          1
        ),
        workflowCommit,
        expectedRunAttempt: 1,
      });
      const first = dispatch(1);
      transition(first);
      transition({
        type: "dispatch-uncertain",
        operationId,
        mode: "promote",
        attemptId: first.attemptId,
      });
      transition({
        type: "fence-dispatch",
        operationId,
        mode: "promote",
        attemptId: first.attemptId,
        fenceReceiptId: "a".repeat(64),
      });
      const second = dispatch(2);
      transition(second);
      const admission = { workflowCommit, runId: "101", runAttempt: 1 };
      expect(() =>
        applyPromotionTransition(current, {
          type: "admit-run",
          operationId,
          mode: "promote",
          attemptId: first.attemptId,
          admission,
        })
      ).toThrow();
      transition({
        type: "admit-run",
        operationId,
        mode: "promote",
        attemptId: second.attemptId,
        admission,
      });
      const deployment = { admission, artifactId: "201", deploymentId: "301" };
      transition({
        type: "deployed",
        operationId,
        mode: "promote",
        attemptId: second.attemptId,
        deployment,
      });
      const verificationBody = {
        destination: "production" as const,
        liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
        releaseId: candidatePublicReleaseId("production", request),
        inventorySha256: request.publicInventorySha256,
        deployment,
        verifiedAt: "2026-10-14T23:01:00.000Z",
        checks: PROMOTION_FIXTURE_CHECKS,
      };
      const verification = {
        ...verificationBody,
        receiptId: promotionDigest(verificationBody),
      };
      transition({
        type: "verified",
        operationId,
        mode: "promote",
        attemptId: second.attemptId,
        verification,
        replayProof: null,
      });
      expect(current.active!.phase).toBe("verified");
      transition({
        type: "acknowledged",
        operationId,
        verificationReceiptId: verification.receiptId,
        acknowledgementId: "9".repeat(64),
        replayProof: null,
      });
      expect(current.active).toBe(null);
      expect(current.completedCount).toBe(1);
      expect(serializePromotionControl(current).length).toBeLessThan(24_000);
      git(remote, ["gc", "--prune=now"]);
      store = create(); // Cold reader replays legal Git parents, not a copied history array.
      const recovered = store.read();
      expect(recovered.head).toBe(head);
      expect(parsePromotionControl(recovered.bytes!).stateId).toBe(
        current.stateId
      );
      const proof = createCompletionProof(
        current.completionRoot,
        request.requestId,
        (sha, type) => store.readCompletionObject(head!, sha, type)
      );
      expect(claimPromotion(current, request, proof).stateId).toBe(
        current.stateId
      );
      expect(() =>
        claimPromotion(
          current,
          { ...request, candidateId: "0".repeat(64) },
          proof
        )
      ).toThrow();
      const nextRequest = syntheticPromotionRequest(current, "next-edition");
      const absence = createCompletionProof(
        current.completionRoot,
        nextRequest.requestId,
        (sha, type) => store.readCompletionObject(head!, sha, type)
      );
      append(claimPromotion(current, nextRequest, absence));
      expect(current.active!.request.requestId).toBe("next-edition");
      expect(
        git(repositoryRoot, ["for-each-ref", "--format=%(refname)"])
          .toString()
          .trim()
      ).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);
});
