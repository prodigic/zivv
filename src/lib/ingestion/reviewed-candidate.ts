import type { IngestionLedger } from "../../types/ingestion.js";
import { captureExportConfiguration } from "./export-configuration.js";
import {
  buildCandidateBundle,
  readVerifiedCandidateBundle,
} from "./candidate-bundle.js";
import {
  captureReviewedSource,
  buildCapturedApplication,
  verifyApplicationBuildReceipt,
  verifyCompiledEtl,
} from "./source-build.js";
import { canonicalJson } from "./sqlite-store.js";
import { normalizeSiteBase } from "../../utils/site-base.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ETLProcessor } from "../etl/processor.js";

/** The integrated recipe always builds its application from the nominated Git commit. */
export async function buildReviewedWeeklyCandidate(input: {
  repositoryRoot: string;
  privateDirectory: string;
  sourceCommit: string;
  purpose: "preview" | "release";
  basePath: string;
  npmCli: string;
  editionId: string;
  weeklyEditionBytes: Buffer;
  ledger: IngestionLedger;
  snapshot: Buffer;
  recoveryKey: Buffer;
  onProgress?: (line: string) => void;
}) {
  const captured = {
    repositoryRoot: input.repositoryRoot,
    privateDirectory: input.privateDirectory,
    sourceCommit: input.sourceCommit,
    purpose: input.purpose,
    basePath: normalizeSiteBase(input.basePath),
    npmCli: input.npmCli,
    editionId: input.editionId,
    weeklyEditionBytes: Buffer.from(input.weeklyEditionBytes),
    ledger: structuredClone(input.ledger),
    snapshot: Buffer.from(input.snapshot),
    recoveryKey: Buffer.from(input.recoveryKey),
    onProgress: input.onProgress,
  };
  captured.onProgress?.("Capturing reviewed source commit\n");
  const source = captureReviewedSource(captured);
  const configuration = captureExportConfiguration(source.sourceRoot);
  configuration["ingestion/weekly-editions.json"] = captured.weeklyEditionBytes;
  const application = await buildCapturedApplication({
    source,
    basePath: captured.basePath,
    npmCli: captured.npmCli,
    onProgress: captured.onProgress,
  });
  const applicationBuildReceipt = Buffer.from(
    canonicalJson(application.receipt) + "\n"
  );
  verifyApplicationBuildReceipt(applicationBuildReceipt, {
    sourceCommit: source.sourceCommit,
    basePath: captured.basePath,
    ...application,
  });
  verifyCompiledEtl(source.sourceRoot, application.receipt.etlInventorySha256);
  const etlModule = (await import(
    pathToFileURL(join(source.sourceRoot, "dist/lib/etl/processor.js")).href
  )) as { ETLProcessor: typeof ETLProcessor };
  captured.onProgress?.("Exporting and sealing captured weekly candidate\n");
  const bundle = await buildCandidateBundle({
    ...captured,
    configuration,
    applicationFiles: application.applicationFiles,
    applicationBuildManifest: application.applicationBuildManifest,
    applicationBuildReceipt,
    executionToolIdentity: application.executionToolIdentity,
    exportData: async (workspace) => {
      verifyCompiledEtl(
        source.sourceRoot,
        application.receipt.etlInventorySha256
      );
      const result = await new etlModule.ETLProcessor(workspace).processData();
      verifyCompiledEtl(
        source.sourceRoot,
        application.receipt.etlInventorySha256
      );
      return result;
    },
  });
  return { ...bundle, sourceDirectory: source.directory };
}

/** Publication policy rejects unproven or preview code on the production path. */
export async function readPublishableCandidate(input: {
  directory: string;
  recoveryKey: Buffer;
  expectedCandidateId: string;
  expectedSourceCommit: string;
  purpose: "preview" | "release";
  basePath: string;
}) {
  const result = await readVerifiedCandidateBundle(
    input.directory,
    input.recoveryKey,
    input.expectedCandidateId
  );
  if (
    !result.applicationBuildReceipt ||
    result.candidate.sourceCommit !== input.expectedSourceCommit ||
    result.candidate.basePath !== normalizeSiteBase(input.basePath)
  )
    throw new Error("Publication lacks matching reviewed build provenance");
  // The bundle reader already validated this receipt and its exact application bytes.
  const receipt: { purpose: unknown } = JSON.parse(
    result.applicationBuildReceipt.toString("utf8")
  );
  if (receipt.purpose !== input.purpose)
    throw new Error("Build purpose does not authorize this publication");
  return result;
}
