import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { setImmediate as yieldToReporter } from "node:timers/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRecoveryResultChainFixture } from "./fixtures/recovery-result-chain-fixture.js";
import { createOperatorRetirementReceipt } from "../../lib/ingestion/operator-installation.js";
import {
  encryptOperatorRecovery,
  type OperatorRecoveryCheckpoint,
} from "../../lib/ingestion/operator-recovery.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { captureNpmExecutionTool } from "../../lib/ingestion/execution-tool-identity.js";
import type { WeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import {
  proveRecoveryResultChain,
  encryptRecoveryResultChain,
  decryptRecoveryResultChain,
  type RecoveryResultChainMembers,
} from "../../lib/ingestion/recovery-result-chain.js";

const sign = (payload: unknown, key: Buffer) =>
  Buffer.from(
    canonicalJson({
      payload,
      signature: createHmac("sha256", key)
        .update(canonicalJson(payload))
        .digest("hex"),
    }) + "\n"
  );
const journalOf = (checkpoint: OperatorRecoveryCheckpoint) =>
  JSON.parse(
    Buffer.from(checkpoint.journal, "base64").toString("utf8")
  ) as WeeklyJournalRecoverySnapshot;
function saveJournal(
  checkpoint: OperatorRecoveryCheckpoint,
  journal: WeeklyJournalRecoverySnapshot
) {
  const { digest: _digest, ...body } = journal;
  checkpoint.journal = Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  ).toString("base64");
}

describe("captured frozen-result chain content proof", () => {
  let directory: string,
    key: Buffer,
    successor: OperatorRecoveryCheckpoint,
    members: RecoveryResultChainMembers;
  let fixture: Awaited<
    ReturnType<typeof createRecoveryResultChainFixture>
  >["fixture"];
  let cleanup: (() => void) | undefined;
  const retire = (
    checkpoint: OperatorRecoveryCheckpoint,
    archive: Buffer,
    id: string
  ) =>
    createOperatorRetirementReceipt(
      {
        checkpointSha256: sha256(canonicalJson(checkpoint)),
        archiveSha256: sha256(archive),
        ledgerRevision: checkpoint.ledgerRevision,
        originalOperatorDirectory: checkpoint.originalOperatorDirectory,
        installationId: id,
        retiredAtEpochMs: checkpoint.createdAtEpochMs + 100,
      },
      key
    );
  const resealSuccessor = (
    mutate: (checkpoint: OperatorRecoveryCheckpoint) => void
  ) => {
    const copy = structuredClone(successor);
    mutate(copy);
    const archive = encryptOperatorRecovery(copy, key);
    return {
      ...members,
      successorArchive: archive,
      successorRetirementReceipt: retire(
        copy,
        archive,
        "22222222-2222-4222-8222-222222222222"
      ),
    };
  };
  beforeAll(async () => {
    // Exercise capture and retirement within one clock tick, so fixture
    // validity cannot depend on taking long enough to consume invented delays.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const created = await createRecoveryResultChainFixture();
      ({ directory, key, successor, members, fixture } = created);
      cleanup = created.cleanup;
    } finally {
      clock.mockRestore();
    }
  }, 180_000);
  afterAll(() => cleanup?.());

  it("roundtrips exact member bytes with fresh nonces and an explicitly non-authorizing detached proof", async () => {
    await yieldToReporter();
    const refs = fixture.refs(),
      proof = proveRecoveryResultChain({ members, recoveryKey: key }),
      first = encryptRecoveryResultChain({ members, recoveryKey: key }),
      second = encryptRecoveryResultChain({ members, recoveryKey: key });
    expect(first.equals(second)).toBe(false);
    expect(first.includes(key)).toBe(false);
    const restored = decryptRecoveryResultChain(first, key);
    expect(restored).toMatchObject({
      activationAllowed: false,
      physicalValidationRequired: true,
      freshRemoteValidationRequired: true,
      chainId: proof.chainId,
    });
    expect(restored.candidate.candidateId).toBe(fixture.candidate.candidateId);
    const historical = restored.originalCheckpoint.runtime.bootstrapNpm!,
      relocated = restored.successorCheckpoint.runtime.bootstrapNpm!,
      prepared = JSON.parse(members.preparedReceipt.toString("utf8"));
    expect(relocated.originalCli).not.toBe(historical.originalCli);
    expect(relocated.identitySha256).not.toBe(historical.identitySha256);
    expect(captureNpmExecutionTool(relocated.originalCli)).toEqual(relocated);
    expect(prepared.npmIdentitySha256).toBe(historical.identitySha256);
    expect(prepared.physicalNpmCli).toBe(relocated.originalCli);
    for (const name of Object.keys(
      members
    ) as (keyof RecoveryResultChainMembers)[])
      expect(restored.members[name]).toEqual(members[name]);
    restored.members.originalArchive.fill(0);
    restored.candidate.files.length = 0;
    expect(
      decryptRecoveryResultChain(first, key).members.originalArchive
    ).toEqual(members.originalArchive);
    expect(fixture.refs()).toBe(refs);
  }, 90_000);

  it("refuses validly reauthenticated package changes and an unadmitted replacement path", () => {
    for (const alter of ["version", "content", "path"] as const) {
      const changed = resealSuccessor((checkpoint) => {
        const { identitySha256: _identity, ...retained } =
          checkpoint.runtime.bootstrapNpm!;
        const payload = {
          ...retained,
          version: alter === "version" ? "11.6.1" : retained.version,
          originalCli:
            alter === "path"
              ? join(directory, "unadmitted-tool/bin/npm-cli.js")
              : retained.originalCli,
          files: retained.files.map((file, index) =>
            alter === "content" && index === 0
              ? { ...file, sha256: "0".repeat(64) }
              : { ...file }
          ),
        };
        checkpoint.runtime.bootstrapNpm = {
          ...payload,
          identitySha256: sha256(canonicalJson(payload)),
        };
      });
      expect(() =>
        proveRecoveryResultChain({ members: changed, recoveryKey: key })
      ).toThrow(alter === "path" ? "MEMBER_MISMATCH" : "BOOTSTRAP_CHANGED");
    }
  });

  it("rejects inconsistent results and preparation even when their HMACs are valid", () => {
    const result = JSON.parse(members.resultReceipt.toString("utf8")).payload;
    result.candidateId = "c".repeat(64);
    expect(() =>
      proveRecoveryResultChain({
        members: { ...members, resultReceipt: sign(result, key) },
        recoveryKey: key,
      })
    ).toThrow("MEMBER_MISMATCH");
    const prepared = JSON.parse(members.preparedReceipt.toString("utf8"));
    prepared.physicalRoot = join(directory, "other");
    const { signature: _signature, ...payload } = prepared;
    const bytes = Buffer.from(
      canonicalJson({
        ...payload,
        signature: createHmac("sha256", key)
          .update(canonicalJson(payload))
          .digest("hex"),
      }) + "\n"
    );
    expect(() =>
      proveRecoveryResultChain({
        members: { ...members, preparedReceipt: bytes },
        recoveryKey: key,
      })
    ).toThrow("MEMBER_MISMATCH");
    expect(() =>
      proveRecoveryResultChain({
        members: {
          ...members,
          successorRetirementReceipt: members.originalRetirementReceipt,
        },
        recoveryKey: key,
      })
    ).toThrow("RETIREMENT_EVIDENCE_MISMATCH");
  });

  it("rejects reauthenticated original-file changes, unexplained output and altered historical receipts", () => {
    const changed = resealSuccessor((checkpoint) => {
      const file = checkpoint.files.find(
        (item) => item.area === "checkout" && item.path === "package.json"
      )!;
      const bytes = Buffer.from("{} \n");
      file.bytes = bytes.toString("base64");
      file.sha256 = sha256(bytes);
    });
    expect(() =>
      proveRecoveryResultChain({ members: changed, recoveryKey: key })
    ).toThrow("ORIGINAL_FILE_CHANGED");
    const extra = resealSuccessor((checkpoint) => {
      const bytes = Buffer.from("extra\n");
      checkpoint.files.push({
        area: "checkout",
        path: "dist/utils/unexplained.js",
        bytes: bytes.toString("base64"),
        sha256: sha256(bytes),
      });
      checkpoint.files.sort((a, b) =>
        (a.area + "/" + a.path).localeCompare(b.area + "/" + b.path, "en")
      );
    });
    expect(() =>
      proveRecoveryResultChain({ members: extra, recoveryKey: key })
    ).toThrow("UNEXPECTED_FILE");
    const altered = resealSuccessor((checkpoint) => {
      const journal = journalOf(checkpoint),
        row = journal.stageArtifacts.find((item) => item.stage === "prepare")!,
        value = JSON.parse(Buffer.from(row.bytes, "base64").toString("utf8"));
      value.schemaVersion = 99;
      const bytes = Buffer.from(canonicalJson(value) + "\n");
      row.bytes = bytes.toString("base64");
      row.identity = sha256(bytes);
      saveJournal(checkpoint, journal);
    });
    expect(() =>
      proveRecoveryResultChain({ members: altered, recoveryKey: key })
    ).toThrow();
  });

  it("rederives a certificate instead of accepting a valid HMAC which claims activation", () => {
    const archive = encryptRecoveryResultChain({ members, recoveryKey: key }),
      outerMagicLength = Buffer.byteLength("ZIVV-RESULT-CHAIN\0"),
      prefixLength = outerMagicLength + 4 + 32 + 12 + 4,
      prefix = archive.subarray(0, prefixLength),
      nonceOffset = outerMagicLength + 4 + 32;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      prefix.subarray(nonceOffset, nonceOffset + 12)
    );
    decipher.setAAD(prefix);
    decipher.setAuthTag(archive.subarray(prefixLength, prefixLength + 16));
    const clear = gunzipSync(
        Buffer.concat([
          decipher.update(archive.subarray(prefixLength + 16)),
          decipher.final(),
        ])
      ),
      innerMagicLength = Buffer.byteLength("ZIVV-CHAIN-MEMBERS\0"),
      innerHeaderLength = innerMagicLength + 2 + 8 * 4,
      certificateOffset =
        innerHeaderLength +
        Array.from({ length: 7 }, (_, index) =>
          clear.readUInt32BE(innerMagicLength + 2 + index * 4)
        ).reduce((a, b) => a + b, 0),
      certificate = JSON.parse(
        clear.subarray(certificateOffset).toString("utf8")
      );
    certificate.payload.activationAllowed = true;
    certificate.signature = createHmac("sha256", key)
      .update("zivv-recovery-frozen-result-chain/certificate/v1\0")
      .update(canonicalJson(certificate.payload))
      .digest("hex");
    const certificateBytes = Buffer.from(canonicalJson(certificate) + "\n"),
      changedHeader = Buffer.from(clear.subarray(0, innerHeaderLength));
    changedHeader.writeUInt32BE(
      certificateBytes.length,
      innerMagicLength + 2 + 7 * 4
    );
    const compressed = gzipSync(
        Buffer.concat([
          changedHeader,
          clear.subarray(innerHeaderLength, certificateOffset),
          certificateBytes,
        ])
      ),
      changedPrefix = Buffer.from(prefix),
      nonce = randomBytes(12);
    nonce.copy(changedPrefix, nonceOffset);
    changedPrefix.writeUInt32BE(compressed.length, prefixLength - 4);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(changedPrefix);
    const ciphertext = Buffer.concat([
        cipher.update(compressed),
        cipher.final(),
      ]),
      forged = Buffer.concat([changedPrefix, cipher.getAuthTag(), ciphertext]);
    expect(() => decryptRecoveryResultChain(forged, key)).toThrow(
      "CERTIFICATE_MISMATCH"
    );
  });

  it("requires the captured source recipe and refuses namespace siblings or empty unexplained directories", () => {
    const missing = resealSuccessor((checkpoint) => {
      checkpoint.files = checkpoint.files.filter(
        (file) => !file.path.includes("/source-build-")
      );
      checkpoint.directories = checkpoint.directories.filter(
        (dir) => !dir.path.includes("/source-build-")
      );
    });
    expect(() =>
      proveRecoveryResultChain({ members: missing, recoveryKey: key })
    ).toThrow("CAPTURED_SOURCE_BUILD_REQUIRED");
    const namespace =
      "weekly-candidates/r-" + sha256(fixture.state.runId).slice(0, 16);
    const sibling = resealSuccessor((checkpoint) => {
      const bytes = Buffer.from("unclaimed\n");
      checkpoint.files.push({
        area: "operator",
        path: namespace + "/unclaimed.txt",
        bytes: bytes.toString("base64"),
        sha256: sha256(bytes),
      });
      checkpoint.files.sort((a, b) =>
        a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
      );
    });
    expect(() =>
      proveRecoveryResultChain({ members: sibling, recoveryKey: key })
    ).toThrow("UNEXPLAINED_BUILD_FILE");
    const empty = resealSuccessor((checkpoint) => {
      checkpoint.directories.push({
        area: "operator",
        path: namespace + "/unused",
      });
      checkpoint.directories.sort((a, b) =>
        a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
      );
    });
    expect(() =>
      proveRecoveryResultChain({ members: empty, recoveryKey: key })
    ).toThrow("UNEXPLAINED_BUILD_DIRECTORY");
    const cache = resealSuccessor((checkpoint) => {
      const recipe = checkpoint.directories.find((dir) =>
          dir.path.endsWith("/source-build-retained")
        )!.path,
        path = recipe + "/source/.cache/fixture.tsbuildinfo",
        bytes = Buffer.from('{"root":[],"version":"5.8.3"}');
      checkpoint.files.push({
        area: "operator",
        path,
        bytes: bytes.toString("base64"),
        sha256: sha256(bytes),
      });
      checkpoint.directories.push({
        area: "operator",
        path: recipe + "/source/.cache",
      });
      checkpoint.files.sort((a, b) =>
        a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
      );
      checkpoint.directories.sort((a, b) =>
        a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
      );
    });
    expect(() =>
      proveRecoveryResultChain({ members: cache, recoveryKey: key })
    ).toThrow("UNEXPLAINED_BUILD_FILE");
  });

  it("authenticates the sole source-only enrich role and refuses altered or extra recipe content", () => {
    for (const change of [
      "missing",
      "capture",
      "blob",
      "source",
      "output",
      "duplicate",
    ] as const) {
      const changed = resealSuccessor((checkpoint) => {
        const recipe = checkpoint.directories.find((dir) =>
          dir.path.endsWith("/candidate-work-enrich/source-build-enrich")
        )!.path;
        if (change === "missing") {
          checkpoint.files = checkpoint.files.filter(
            (file) => !file.path.startsWith(recipe + "/")
          );
          checkpoint.directories = checkpoint.directories.filter(
            (dir) => !dir.path.includes("/candidate-work-enrich")
          );
        } else if (change === "duplicate") {
          checkpoint.directories.push({
            area: "operator",
            path:
              recipe.slice(0, recipe.indexOf("/candidate-work-enrich")) +
              "/candidate-work-duplicate",
          });
        } else if (change === "output") {
          const bytes = Buffer.from("{}\n");
          checkpoint.files.push({
            area: "operator",
            path: recipe + "/execution-tools.json",
            bytes: bytes.toString("base64"),
            sha256: sha256(bytes),
          });
        } else {
          const suffix =
              change === "capture"
                ? "source-capture.json"
                : change === "blob"
                  ? "source.blobs"
                  : "source/package-lock.json",
            row = checkpoint.files.find(
              (file) => file.path === recipe + "/" + suffix
            )!;
          let bytes: Buffer;
          if (change === "capture") {
            const capture = JSON.parse(
              Buffer.from(row.bytes!, "base64").toString()
            );
            capture.directory = join(directory, "unbound-source");
            bytes = Buffer.from(canonicalJson(capture) + "\n");
          } else
            bytes = Buffer.concat([
              Buffer.from(row.bytes!, "base64"),
              Buffer.from("changed\n"),
            ]);
          row.bytes = bytes.toString("base64");
          row.sha256 = sha256(bytes);
        }
        checkpoint.files.sort((a, b) =>
          a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
        );
        checkpoint.directories.sort((a, b) =>
          a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
        );
      });
      const code =
        change === "missing" || change === "duplicate"
          ? "ENRICH_SOURCE_CAPTURE_REQUIRED"
          : change === "capture"
            ? "ENRICH_SOURCE_CAPTURE_CHANGED"
            : change === "output"
              ? "UNEXPLAINED_BUILD_FILE"
              : "ENRICH_SOURCE_CONTENT_CHANGED";
      expect(() =>
        proveRecoveryResultChain({ members: changed, recoveryKey: key })
      ).toThrow(code);
    }
  });

  it("refuses modified source content and later build attempts instead of treating every validated result as supported", () => {
    const changed = resealSuccessor((checkpoint) => {
      const row = checkpoint.files.find(
        (file) =>
          file.path.includes("/source-build-") &&
          file.path.endsWith("/source/package-lock.json")
      )!;
      const bytes = Buffer.from("changed lock\n");
      row.bytes = bytes.toString("base64");
      row.sha256 = sha256(bytes);
    });
    expect(() =>
      proveRecoveryResultChain({ members: changed, recoveryKey: key })
    ).toThrow("SOURCE_CONTENT_CHANGED");
    const attempted = resealSuccessor((checkpoint) => {
      const journal = journalOf(checkpoint),
        row = journal.runState.find((item) => item.id === fixture.state.runId)!,
        state = JSON.parse(row.payload),
        prior = journal.stageArtifacts.find(
          (item) =>
            item.runId === fixture.state.runId && item.stage === "validate"
        )!;
      const second = { ...prior, attempt: 2 };
      journal.stageArtifacts.push(second);
      const diagnostic = Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          blockedCode: "STAGE_EVIDENCE_FAILED",
        }) + "\n"
      );
      prior.bytes = diagnostic.toString("base64");
      prior.identity = sha256(diagnostic);
      journal.stageArtifacts.sort((a, b) =>
        a.runId < b.runId
          ? -1
          : a.runId > b.runId
            ? 1
            : a.stage < b.stage
              ? -1
              : a.stage > b.stage
                ? 1
                : a.attempt - b.attempt
      );
      state.stages[7].attempt = 2;
      state.revision += 2;
      row.payload = canonicalJson(state);
      row.revision = state.revision;
      saveJournal(checkpoint, journal);
    });
    expect(() =>
      proveRecoveryResultChain({ members: attempted, recoveryKey: key })
    ).toThrow("CLEAN_FIRST_BUILD_REQUIRED");
    const poisonedMembers = { ...members, recoveryKey: key };
    expect(() =>
      proveRecoveryResultChain({ members: poisonedMembers, recoveryKey: key })
    ).toThrow("INVALID_FIELDS");
    const result = JSON.parse(members.resultReceipt.toString("utf8")).payload;
    result.githubToken = "forbidden fixture token";
    expect(() =>
      proveRecoveryResultChain({
        members: { ...members, resultReceipt: sign(result, key) },
        recoveryKey: key,
      })
    ).toThrow("INVALID_FIELDS");
  });
});
