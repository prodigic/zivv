import { createHash, createHmac } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { captureNpmExecutionTool } from "../../../lib/ingestion/execution-tool-identity.js";
import { createRecoveryCandidateRemoteFixture } from "./recovery-candidate-remote-fixture.js";
import { createOperatorRetirementReceipt } from "../../../lib/ingestion/operator-installation.js";
import {
  encryptOperatorRecovery,
  type OperatorRecoveryCheckpoint,
} from "../../../lib/ingestion/operator-recovery.js";
import {
  canonicalJson,
  ledgerDigest,
} from "../../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../../lib/ingestion/steve-preflight.js";
import { parsePromotionControl } from "../../../lib/ingestion/promotion-control.js";
import {
  sealReleaseCandidate,
  CANDIDATE_CONFIG_FILES,
  type CandidateConfiguration,
} from "../../../lib/ingestion/release-candidate.js";
import type { WeeklyJournalRecoverySnapshot } from "../../../lib/ingestion/weekly-run-journal.js";
import type { RecoveryResultChainMembers } from "../../../lib/ingestion/recovery-result-chain.js";

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

export async function createRecoveryResultChainFixture() {
  const directory = mkdtempSync(join(tmpdir(), "zivv-result-chain-"));
  try {
    const fixture = await createRecoveryCandidateRemoteFixture(directory);
    const key = fixture.key;
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

    // Format-unit fixture: real imported SQLite rows/sealed bundle, synthetic app
    // build receipt. This is not the later genuine two-host recapture rehearsal.
    const original = structuredClone(fixture.checkpoint);
    original.originalOperatorDirectory = join(
      directory,
      "retired-original",
      "operator"
    );
    original.originalCheckout = join(directory, "retired-original", "checkout");
    original.files = original.files.filter(
      (file) =>
        file.area !== "operator" || !file.path.startsWith("weekly-candidates/")
    );
    original.directories = original.directories.filter(
      (dir) =>
        dir.area !== "operator" || !dir.path.startsWith("weekly-candidates")
    );
    const oldJournal = journalOf(original),
      runRow = oldJournal.runState.find(
        (row) => row.id === fixture.state.runId
      )!;
    const frozenRun = JSON.parse(runRow.payload);
    frozenRun.stages
      .slice(5)
      .forEach(
        (stage: {
          status: string;
          attempt: number;
          evidence: unknown;
          errorCode: unknown;
        }) => {
          stage.status = "pending";
          stage.attempt = 0;
          stage.evidence = null;
          stage.errorCode = null;
        }
      );
    frozenRun.revision = 10;
    runRow.revision = 10;
    runRow.payload = canonicalJson(frozenRun);
    oldJournal.stageArtifacts = oldJournal.stageArtifacts.filter(
      (row) =>
        row.runId !== fixture.state.runId ||
        ["acquire", "prepare", "reconcile", "load", "freeze"].includes(
          row.stage
        )
    );
    saveJournal(original, oldJournal);
    const successor = structuredClone(fixture.checkpoint);
    const replacementToolRoot = join(directory, "replacement-tool");
    cpSync(dirname(dirname(fixture.npmCli)), replacementToolRoot, {
      recursive: true,
    });
    const replacementNpmCli = join(replacementToolRoot, "bin/npm-cli.js"),
      replacementTool = captureNpmExecutionTool(replacementNpmCli),
      replacementToolBytes = Buffer.from(canonicalJson(replacementTool) + "\n");
    successor.runtime.bootstrapNpm = replacementTool;
    const root = join(directory, "intermediate"),
      operator = join(root, "operator"),
      namespace =
        "weekly-candidates/r-" + sha256(fixture.state.runId).slice(0, 16);
    successor.originalOperatorDirectory = operator;
    successor.originalCheckout = join(root, "checkout");
    successor.createdAtEpochMs = original.createdAtEpochMs + 2000;
    for (const file of successor.files)
      if (
        file.area === "operator" &&
        file.path.startsWith("weekly-candidates/")
      )
        file.path = namespace + file.path.slice("weekly-candidates".length);
    for (const dir of successor.directories)
      if (dir.area === "operator" && dir.path.startsWith("weekly-candidates/"))
        dir.path = namespace + dir.path.slice("weekly-candidates".length);
    successor.directories.push({ area: "operator", path: namespace });
    successor.files.sort((a, b) =>
      (a.area + "/" + a.path).localeCompare(b.area + "/" + b.path, "en")
    );
    successor.directories.sort((a, b) =>
      (a.area + "/" + a.path).localeCompare(b.area + "/" + b.path, "en")
    );
    const nextJournal = journalOf(successor),
      exported = nextJournal.stageArtifacts.find(
        (row) => row.runId === fixture.state.runId && row.stage === "export"
      )!,
      intent = JSON.parse(
        Buffer.from(exported.bytes, "base64").toString("utf8")
      );
    intent.workDirectory = join(
      operator,
      ...namespace.split("/"),
      "candidate-work-retained"
    );
    const exportBytes = Buffer.from(canonicalJson(intent) + "\n");
    exported.bytes = exportBytes.toString("base64");
    exported.identity = sha256(exportBytes);
    saveJournal(successor, nextJournal);
    // Retain the actual source-build recipe with internally consistent source
    // blobs, inventories and receipts. Compilation itself remains synthetic.
    const workRelative = namespace + "/candidate-work-retained",
      bundleRelative = successor.directories.find(
        (dir) =>
          dir.area === "operator" &&
          dir.path.startsWith(workRelative + "/candidate-")
      )!.path,
      sourceRelative = workRelative + "/source-build-retained",
      sourceDirectory = join(operator, ...sourceRelative.split("/"));
    const fileAt = (path: string) =>
      successor.files.find(
        (file) =>
          file.area === "operator" && file.path === bundleRelative + "/" + path
      )!;
    const read = (path: string) => Buffer.from(fileAt(path).bytes!, "base64");
    const put = (path: string, bytes: Buffer) => {
      const existing = successor.files.find(
          (file) => file.area === "operator" && file.path === path
        ),
        row = {
          area: "operator" as const,
          path,
          bytes: bytes.toString("base64"),
          sha256: sha256(bytes),
        };
      if (existing) Object.assign(existing, row);
      else successor.files.push(row);
      const parts = path.split("/");
      for (let count = 1; count < parts.length; count++)
        if (
          !successor.directories.some(
            (dir) =>
              dir.area === "operator" &&
              dir.path === parts.slice(0, count).join("/")
          )
        )
          successor.directories.push({
            area: "operator",
            path: parts.slice(0, count).join("/"),
          });
    };
    const lock = Buffer.from("fixture lock\n"),
      blob = createHash("sha1")
        .update(Buffer.from(`blob ${lock.length}\0`))
        .update(lock)
        .digest("hex"),
      sourceFiles = [{ path: "package-lock.json", blob, mode: "100644" }],
      sourceBlobs = Buffer.concat([
        Buffer.from(`${blob} blob ${lock.length}\n`),
        lock,
        Buffer.from("\n"),
      ]);
    const writtenBlob = fixture.git(
      ["hash-object", "-w", "--stdin"],
      lock.toString("utf8")
    );
    if (writtenBlob !== blob)
      throw new Error("Fixture git blob identity mismatch");
    const sourceTree = fixture.git(
        ["mktree"],
        `100644 blob ${blob}\tpackage-lock.json\n`
      ),
      buildSourceCommit = fixture.git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit-tree",
        sourceTree,
        "-p",
        fixture.workflowCommit,
        "-m",
        "minimal captured build source",
      ]);
    fixture.git([
      "push",
      "--quiet",
      fixture.bareDirectory,
      `${buildSourceCommit}:refs/heads/main`,
    ]);
    const compiled = Buffer.from("// synthetic compiled fixture\n"),
      application = JSON.parse(
        read("build/application-build.json").toString("utf8")
      );
    application.sourceCommit = buildSourceCommit;
    application.sourceTree = sourceTree;
    application.sourceInventorySha256 = sha256(canonicalJson(sourceFiles));
    application.archiveSha256 = sha256(sourceBlobs);
    application.packageLockSha256 = sha256(lock);
    application.executionToolSha256 = sha256(replacementToolBytes);
    application.etlInventorySha256 = sha256(
      canonicalJson([
        {
          path: "lib/etl/processor.js",
          size: compiled.length,
          sha256: sha256(compiled),
        },
      ])
    );
    const applicationBytes = Buffer.from(canonicalJson(application) + "\n"),
      configuration = Object.fromEntries(
        CANDIDATE_CONFIG_FILES.map((path) => [
          path,
          successor.files.find(
            (file) => file.area === "checkout" && file.path === "data/" + path
          )?.bytes ?? null,
        ]).map(([path, bytes]) => [
          path,
          bytes === null ? null : Buffer.from(bytes, "base64"),
        ])
      ) as CandidateConfiguration,
      publicFiles = new Map(
        fixture.candidate.files.map((file) => [
          file.path,
          read("workspace/public/" + file.path),
        ])
      ),
      replacementCandidate = sealReleaseCandidate({
        sourceCommit: buildSourceCommit,
        basePath: "/zivv/",
        ledger: successor.ledger,
        snapshot: read("recovery/ledger.snapshot.enc"),
        recoveryKey: key,
        configuration,
        editionId: fixture.candidate.editionId,
        publicFiles,
        applicationBuildManifest: read("build/vite-manifest.json"),
        applicationBuildReceipt: applicationBytes,
        executionToolIdentity: replacementToolBytes,
      });
    put(
      bundleRelative + "/candidate.json",
      Buffer.from(canonicalJson(replacementCandidate) + "\n")
    );
    put(
      bundleRelative + "/complete.json",
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          candidateId: replacementCandidate.candidateId,
        }) + "\n"
      )
    );
    put(bundleRelative + "/build/application-build.json", applicationBytes);
    put(bundleRelative + "/build/execution-tools.json", replacementToolBytes);
    put(
      sourceRelative + "/source-capture.json",
      Buffer.from(
        canonicalJson({
          directory: sourceDirectory,
          sourceRoot: join(sourceDirectory, "source"),
          sourceCommit: buildSourceCommit,
          sourceTree,
          files: sourceFiles,
          archiveSha256: sha256(sourceBlobs),
          purpose: "release",
        }) + "\n"
      )
    );
    put(sourceRelative + "/source.blobs", sourceBlobs);
    put(sourceRelative + "/source/package-lock.json", lock);
    put(sourceRelative + "/source/dist/lib/etl/processor.js", compiled);
    put(sourceRelative + "/application-build.json", applicationBytes);
    put(
      sourceRelative + "/execution-tools.json",
      read("build/execution-tools.json")
    );
    put(sourceRelative + "/empty.npmrc", Buffer.alloc(0));
    for (const file of application.applicationFiles)
      put(
        sourceRelative + "/application/" + file.path,
        publicFiles.get(file.path)!
      );
    put(
      sourceRelative + "/application/.vite/manifest.json",
      read("build/vite-manifest.json")
    );
    const enriched = nextJournal.stageArtifacts.find(
        (row) => row.stage === "enrich"
      )!,
      enrichedValue = JSON.parse(
        Buffer.from(enriched.bytes, "base64").toString("utf8")
      );
    enrichedValue.build.sourceCommit = buildSourceCommit;
    enrichedValue.build.npmCli = replacementNpmCli;
    const enrichedBytes = Buffer.from(canonicalJson(enrichedValue) + "\n");
    enriched.bytes = enrichedBytes.toString("base64");
    enriched.identity = sha256(enrichedBytes);
    const nextRunRow = nextJournal.runState.find(
        (row) => row.id === fixture.state.runId
      )!,
      nextRun = JSON.parse(nextRunRow.payload);
    nextRun.stages[5].evidence.buildSha256 = sha256(
      canonicalJson(enrichedValue.build)
    );
    nextRun.stages[6].evidence.candidateId = replacementCandidate.candidateId;
    nextRun.stages[7].evidence.candidateId = replacementCandidate.candidateId;
    nextRunRow.payload = canonicalJson(nextRun);
    const validated = nextJournal.stageArtifacts.find(
        (row) => row.stage === "validate"
      )!,
      validationBytes = Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          candidateId: replacementCandidate.candidateId,
          manifestSha256: replacementCandidate.manifestSha256,
        }) + "\n"
      );
    validated.bytes = validationBytes.toString("base64");
    validated.identity = sha256(validationBytes);
    saveJournal(successor, nextJournal);
    fixture.candidate = replacementCandidate;
    successor.files.sort((a, b) =>
      a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
    );
    successor.directories.sort((a, b) =>
      a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
    );
    const originalArchive = encryptOperatorRecovery(original, key),
      successorArchive = encryptOperatorRecovery(successor, key),
      originalRetirementReceipt = retire(
        original,
        originalArchive,
        "11111111-1111-4111-8111-111111111111"
      ),
      successorRetirementReceipt = retire(
        successor,
        successorArchive,
        "22222222-2222-4222-8222-222222222222"
      ),
      preparedPayload = {
        kind: "zivv-prepared-recovery-runtime",
        version: 1,
        archiveSha256: sha256(originalArchive),
        retirementSha256: sha256(originalRetirementReceipt),
        physicalRoot: root,
        physicalNpmCli: replacementNpmCli,
        npmIdentitySha256: original.runtime.bootstrapNpm!.identitySha256,
        status: "prepared",
        activationAllowed: false,
        checkpointSha256: sha256(canonicalJson(original)),
        ledgerRevision: original.ledgerRevision,
        treeSha256: "a".repeat(64),
        entryCount: 10,
        workerProbe: "quarantine-enforced",
      },
      preparedReceipt = Buffer.from(
        canonicalJson({
          ...preparedPayload,
          signature: createHmac("sha256", key)
            .update(canonicalJson(preparedPayload))
            .digest("hex"),
        }) + "\n"
      ),
      current = fixture.store.read(),
      control = parsePromotionControl(current.bytes!),
      remote = {
        mainHead: buildSourceCommit,
        controlHead: current.head,
        controlSha256: sha256(current.bytes!),
        acknowledgedOperationId: fixture.operationId,
        acknowledgedCandidateId: fixture.candidateId,
        acknowledgedLedgerRevision: ledgerDigest(fixture.baseline),
        acknowledgedCutoffEpochMs: Date.parse("2026-10-16T19:00:00Z"),
        runId: fixture.state.runId,
        ledgerRevision: original.ledgerRevision,
        sourceCommit: buildSourceCommit,
        freezeSha256: oldJournal.stageArtifacts.find(
          (row) => row.stage === "freeze"
        )!.identity,
      },
      admissionPayload = {
        kind: "zivv-recovery-frozen-admission",
        version: 1,
        scope: "one-frozen-run-through-validate",
        activationAllowed: false,
        root,
        operator,
        repositoryRoot: fixture.repositoryRoot,
        physicalNpmCli: replacementNpmCli,
        checkpointSha256: preparedPayload.checkpointSha256,
        archiveSha256: sha256(originalArchive),
        retirementSha256: sha256(originalRetirementReceipt),
        preparedReceiptSha256: sha256(preparedReceipt),
        runId: fixture.state.runId,
        source: fixture.state.source,
        reportPath:
          "checkout/data/ingestion/reports/" +
          sha256(String(fixture.state.stages[3].evidence!.importRunId)) +
          ".json",
        sourceCommit: buildSourceCommit,
        configurationSha256: fixture.candidate.configSha256,
        buildParent: join(operator, ...namespace.split("/")),
        remote,
        transport: {
          kind: "temporary-bare-test",
          directory: fixture.bareDirectory,
        },
        immutableSha256: "b".repeat(64),
      },
      admissionReceipt = sign(admissionPayload, key),
      resultReceipt = sign(
        {
          status: "candidate-validated",
          activationAllowed: false,
          runId: fixture.state.runId,
          ledgerRevision: original.ledgerRevision,
          admissionSha256: sha256(admissionReceipt),
          candidateId: fixture.candidate.candidateId,
        },
        key
      );
    if (control.active !== null)
      throw new Error("Fixture promotion control must be inactive");
    const members: RecoveryResultChainMembers = {
      originalArchive,
      originalRetirementReceipt,
      preparedReceipt,
      admissionReceipt,
      resultReceipt,
      successorArchive,
      successorRetirementReceipt,
    };
    const cleanup = () => {
      const within = relative(tmpdir(), directory);
      if (!within.startsWith("zivv-result-chain-") || within.startsWith(".."))
        throw new Error("Unsafe recovery result chain fixture cleanup");
      rmSync(directory, { recursive: true, force: true });
    };
    return { directory, key, original, successor, members, fixture, cleanup };
  } catch (error) {
    const within = relative(tmpdir(), directory);
    if (within.startsWith("zivv-result-chain-") && !within.startsWith(".."))
      rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
