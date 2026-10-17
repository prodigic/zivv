import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Use ESLint's already locked direct dependency in both npm and pnpm layouts.
const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint/package.json"));
const { load } = eslintRequire("js-yaml") as {
  load(source: string): unknown;
};

interface WorkflowStep {
  name: string;
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
}
interface WorkflowJob {
  needs?: string;
  if?: string;
  environment?: { name: string };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: WorkflowStep[];
}
interface Workflow {
  on: Record<
    string,
    {
      inputs: Record<
        string,
        { required: boolean; type: string; options?: string[] }
      >;
    }
  >;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, WorkflowJob>;
}

const source = readFileSync(".github/workflows/publish-candidate.yml", "utf8");
const workflow = load(source) as Workflow;
const publisher = workflow.jobs.publish;
const steps = publisher.steps;
const commands = steps.filter((step) => step.run);

describe("reviewed exact-candidate Pages workflow", () => {
  it("is explicit dispatch only with closed production inputs", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual([
      "request_id",
      "operation_id",
      "attempt_id",
      "control_head",
      "payload_commit",
      "candidate_id",
      "source_commit",
      "mode",
      "destination",
    ]);
    expect(Object.values(inputs).every((input) => input.required)).toBe(true);
    expect(inputs.mode.options).toEqual(["promote", "rollback"]);
    expect(inputs.destination.options).toEqual(["production"]);
  });

  it("fails activation unless both known prerequisites are explicitly set", () => {
    const activation = workflow.jobs.activation;
    expect(publisher.needs).toBe("activation");
    expect(publisher.if).toBeUndefined();
    expect(activation.if).toBeUndefined();
    expect(activation.env).toEqual({
      ZIVV_CONTROLLED_PUBLISHING: "${{ vars.ZIVV_CONTROLLED_PUBLISHING }}",
      ZIVV_MANUAL_PUBLISHER_JOINED: "${{ vars.ZIVV_MANUAL_PUBLISHER_JOINED }}",
    });
    expect(publisher.env!.ZIVV_CONTROLLED_PUBLISHING).toBe(
      activation.env!.ZIVV_CONTROLLED_PUBLISHING
    );
    expect(publisher.env!.ZIVV_MANUAL_PUBLISHER_JOINED).toBe(
      activation.env!.ZIVV_MANUAL_PUBLISHER_JOINED
    );
    const script = activation.steps[0].run!.match(
      /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\n?$/
    )![1];
    for (const [enabled, joined, status] of [
      ["", "", 1],
      ["enabled", "", 1],
      ["", "true", 1],
      ["true", "true", 1],
      ["enabled", "enabled", 1],
      ["enabled", "true", 0],
    ] as const) {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: {
            ZIVV_CONTROLLED_PUBLISHING: enabled,
            ZIVV_MANUAL_PUBLISHER_JOINED: joined,
          },
          encoding: "utf8",
          windowsHide: true,
        }
      );
      expect(result.status, `${enabled}/${joined}: ${result.stderr}`).toBe(
        status
      );
    }
  });

  it("uses the maintained Pages concurrency and grants effects only to the publisher", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.activation.permissions).toBeUndefined();
    expect(workflow.concurrency).toEqual({
      group: "pages",
      "cancel-in-progress": false,
    });
    expect(publisher.permissions).toEqual({
      contents: "write",
      actions: "write",
      pages: "write",
      "id-token": "write",
    });
    expect(publisher.environment).toEqual({ name: "github-pages" });
  });

  it("pins reviewed tools and checks out the executing workflow SHA rather than payload code", () => {
    const actions = steps.filter((step) => step.uses);
    expect(actions).toHaveLength(3);
    for (const step of actions) {
      expect(step.uses).toMatch(/^actions\/[a-z-]+@[a-f0-9]{40}$/);
    }
    const checkout = actions.find((step) =>
      step.uses!.startsWith("actions/checkout@")
    )!;
    expect(checkout.with).toEqual({
      ref: "${{ github.sha }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(
      actions.find((step) => step.uses!.startsWith("actions/setup-node@"))!.with
    ).toEqual({
      "node-version": "24.19.0",
    });
    expect(commands.every((step) => !step.run!.includes("${{"))).toBe(true);
    for (const input of Object.keys(workflow.on.workflow_dispatch.inputs)) {
      expect(publisher.env![`ZIVV_${input.toUpperCase()}`]).toBe(
        `\${{ inputs.${input} }}`
      );
    }
  });

  it("compiles only ingestion tooling without rebuilding, importing or exposing credentials", () => {
    const install = commands.find(
      (step) => step.run === "npm ci --ignore-scripts"
    )!;
    const compile = commands.find(
      (step) => step.name === "Compile ingestion controller only"
    )!;
    expect(install).toBeDefined();
    expect(compile.run).toContain("src/lib/ingestion/**/*.ts");
    expect(compile.run).toContain(
      './node_modules/.bin/tsc --project "$RUNNER_TEMP/tsconfig.pages.json"'
    );
    for (const step of [install, compile]) {
      expect(step.env).toEqual({
        GITHUB_TOKEN: "",
        NODE_AUTH_TOKEN: "",
        NPM_TOKEN: "",
        ACTIONS_RUNTIME_TOKEN: "",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
      });
    }
    for (const step of commands) {
      expect(step.run).not.toMatch(
        /vite|run-etl|ledger-store|npm run build|npm run etl|import-events/
      );
      expect(step.run).not.toMatch(
        /\b(?:echo|printf|printenv|env)\b.*(?:TOKEN|KEY|SECRET)/
      );
    }
    expect(source).not.toContain("secrets.");
  });

  it("requires the immutable workflow tag and main ancestry before running installed tooling", () => {
    const review = commands.find(
      (step) =>
        step.name ===
        "Require immutable reviewed code before installing tooling"
    )!;
    const install = commands.find(
      (step) => step.run === "npm ci --ignore-scripts"
    )!;
    expect(steps.indexOf(review)).toBeLessThan(steps.indexOf(install));
    expect(review.env).toEqual({
      ZIVV_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
    });
    expect(review.run).toContain("ref !== 'refs/tags/zivv-workflows/' + sha");
    expect(review.run).toContain("process.env.ZIVV_DEFAULT_BRANCH !== 'main'");
    expect(review.run).toContain(
      "process.env.GITHUB_REPOSITORY !== 'prodigic/zivv'"
    );
    expect(review.run).toContain(
      "process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'"
    );
    expect(review.run).toContain(
      "['--no-replace-objects', 'rev-parse', '--verify', ref + '^{commit}']"
    );
    expect(review.run).toContain(
      "['--no-replace-objects', 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']"
    );
  });

  it("admits before uploading site-only bytes and records deployment before status reconciliation", () => {
    expect(publisher.env!.ZIVV_PAGES_STATE_PATH).toBe(
      "${{ runner.temp }}/zivv-pages-operation.json"
    );
    expect(publisher.env!.ZIVV_SITE_DIRECTORY).toBe(
      "${{ runner.temp }}/zivv-pages-site"
    );
    const controllerCommands = commands.filter((step) =>
      step.run!.startsWith("node scripts/run-pages-candidate.js ")
    );
    expect(controllerCommands.map((step) => step.run)).toEqual([
      "node scripts/run-pages-candidate.js admit",
      "node scripts/run-pages-candidate.js materialize",
      "node scripts/run-pages-candidate.js request-deployment",
      "node scripts/run-pages-candidate.js status",
      "node scripts/run-pages-candidate.js receipt",
      "node scripts/run-pages-candidate.js verify-release",
    ]);
    const upload = steps.find((step) => step.id === "upload")!;
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload.with).toEqual({
      name: "github-pages",
      path: "${{ runner.temp }}/artifact.tar",
      "retention-days": 1,
      "if-no-files-found": "error",
    });
    expect(steps.indexOf(controllerCommands[1])).toBeLessThan(
      steps.indexOf(upload)
    );
    expect(steps.indexOf(upload)).toBeLessThan(
      steps.indexOf(controllerCommands[2])
    );
    expect(controllerCommands[2].env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      ZIVV_ARTIFACT_ID: "${{ steps.upload.outputs.artifact-id }}",
    });
    const verify = steps.find((step) => step.id === "verify")!;
    expect(verify["continue-on-error"]).toBe(true);
    const rollback = steps.find((step) =>
      step.name.startsWith("Queue guarded")
    )!;
    expect(rollback.if).toBe(
      "always() && (steps.verify.outcome == 'failure' || steps.deployment_status.outcome == 'failure') && inputs.mode == 'promote'"
    );
    expect(rollback.run).toContain("--mode rollback");
    expect(
      steps.find((step) => step.name.startsWith("Alert on"))!.run
    ).toContain("exit 1");
    expect(
      commands.some((step) =>
        step.run!.includes("run-pages-candidate.js acknowledge")
      )
    ).toBe(false);
  });
});
