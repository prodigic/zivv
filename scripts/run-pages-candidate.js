#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPagesCandidateRunner,
  readPagesRunnerIdentity,
  requirePagesScratchPaths,
  PagesCreationUncertainError,
} from "../dist/lib/ingestion/pages-candidate-runner.js";
import {
  createAuthoritativePromotionControlTransport,
  createRemotePromotionControlStore,
} from "../dist/lib/ingestion/promotion-control-git.js";
import {
  parsePromotionControl,
  validatePromotionAppend,
} from "../dist/lib/ingestion/promotion-control.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (
    args.length ||
    ![
      "admit",
      "materialize",
      "request-deployment",
      "status",
      "receipt",
      "verify-release",
    ].includes(command)
  )
    throw new Error(
      "Usage: run-pages-candidate.js admit|materialize|request-deployment|status|receipt|verify-release"
    );
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const identity = readPagesRunnerIdentity(process.env, root);
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const statePath =
    process.env.ZIVV_PAGES_STATE_PATH ??
    join(runnerTemp, "zivv-pages-operation.json");
  const siteDirectory =
    process.env.ZIVV_SITE_DIRECTORY ?? join(runnerTemp, "zivv-pages-site");
  const archivePath = join(runnerTemp, "artifact.tar");
  requirePagesScratchPaths(runnerTemp, root, [
    statePath,
    siteDirectory,
    archivePath,
  ]);
  const token = process.env.GITHUB_TOKEN ?? "";
  const transport = createAuthoritativePromotionControlTransport(
    root,
    token ? { token } : undefined
  );
  const store = createRemotePromotionControlStore({
    repositoryRoot: root,
    destination: "production",
    transport,
    validateState: (bytes, destination) => {
      const state = parsePromotionControl(bytes);
      if (state.destination !== destination)
        throw new Error("Wrong control destination");
      return state.completionRoot;
    },
    validateTransition: validatePromotionAppend,
  });
  const runner = createPagesCandidateRunner({
    repositoryRoot: root,
    identity,
    statePath,
    siteDirectory,
    archivePath,
    store,
    transport,
    githubToken: token,
    artifactId: process.env.ZIVV_ARTIFACT_ID,
    getOidcToken: async () => {
      const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !url.hostname.endsWith(".actions.githubusercontent.com")
      )
        throw new Error("Invalid GitHub OIDC request origin");
      const credential = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
      if (!credential)
        throw new Error("Missing GitHub OIDC request credential");
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${credential}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("GitHub OIDC request failed");
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("GitHub OIDC response missing");
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65_536) {
          await reader.cancel();
          throw new Error("GitHub OIDC response exceeds limit");
        }
        chunks.push(part.value);
      }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof result.value !== "string") throw new Error();
        return result.value;
      } catch {
        throw new Error("GitHub OIDC credential response is invalid");
      }
    },
  });
  return await {
    admit: () => runner.admit(),
    materialize: () => runner.materialize(),
    "request-deployment": () => runner.requestDeployment(),
    status: () => runner.status(),
    receipt: () => runner.receipt(),
    "verify-release": () => runner.verifyRelease(),
  }[command]();
}
try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  if (error instanceof PagesCreationUncertainError)
    console.error(JSON.stringify(error.recovery));
  console.error(
    "Pages candidate command failed; retain controller ownership and reconcile with the reviewed operator tooling."
  );
  process.exitCode = 1;
}
