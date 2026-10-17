import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint/package.json"));
const { load } = eslintRequire("js-yaml") as { load(source: string): unknown };
interface Step {
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  steps: Step[];
}
interface Workflow {
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}
const workflow = load(
  readFileSync(".github/workflows/deploy.yml", "utf8")
) as Workflow;
const controlled = load(
  readFileSync(".github/workflows/publish-candidate.yml", "utf8")
) as Workflow;
const gateId = "publisher-mode";
const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
const dependencies = (job: Job) =>
  typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);

function gateJob(): Job {
  const job = workflow.jobs[gateId];
  if (!job) throw new Error("Missing fail-closed publisher-mode job");
  return job;
}
function expression(value: string): string {
  return value
    .replace(/^\s*\$\{\{\s*/, "")
    .replace(/\s*\}\}\s*$/, "")
    .trim();
}

// Interpret only the explicit conjunctions supported by the checked workflow.
// Unknown syntax fails the fixture rather than assuming a permissive job result.
function condition(
  job: Job,
  mode: string | undefined,
  event: "push" | "pull_request"
) {
  if (!job.if) throw new Error("Legacy effect job lacks a mode condition");
  const values: Record<string, string | undefined> = {
    [`needs.${gateId}.outputs.mode`]: mode,
    [`needs.${gateId}.result`]: "success",
    "needs.build.result": "success",
    "github.ref": event === "push" ? "refs/heads/main" : "refs/pull/1/merge",
    "github.event_name": event,
  };
  return expression(job.if)
    .split(/\s*&&\s*/)
    .every((term) => {
      if (term === "success()") return true;
      const match = term.match(/^([\w.-]+)\s*==\s*['"]([^'"]*)['"]$/);
      if (!match || !Object.hasOwn(values, match[1]))
        throw new Error(`Unsupported legacy condition: ${term}`);
      return values[match[1]] === match[2];
    });
}

function runGate(publishing: string, joined: string) {
  const job = gateJob();
  const directory = mkdtempSync(join(tmpdir(), "zivv-publisher-mode-"));
  const outputs = new Map<string, string>();
  let status = 0;
  const resolveEnv = (env: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        value
          .replaceAll("${{ vars.ZIVV_CONTROLLED_PUBLISHING }}", publishing)
          .replaceAll("${{ vars.ZIVV_MANUAL_PUBLISHER_JOINED }}", joined),
      ])
    );
  try {
    for (const [index, step] of job.steps.entries()) {
      if (status !== 0) break;
      if (!step.run || step.uses || step.if || step["continue-on-error"])
        throw new Error(
          "Mode gate must contain unconditional fail-closed shell steps"
        );
      const output = join(directory, `output-${index}`);
      const result = spawnSync(bash, ["-e", "-o", "pipefail", "-c", step.run], {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          ...resolveEnv(job.env),
          ...resolveEnv(step.env),
          GITHUB_OUTPUT: output,
        },
      });
      if (result.error) throw result.error;
      status = result.status ?? 1;
      if (result.signal || ![0, 1].includes(status))
        throw new Error(
          `Publisher gate shell failed before a valid policy result: ${result.status} ${result.stderr}`
        );
      if (step.id && existsSync(output))
        outputs.set(step.id, readFileSync(output, "utf8"));
    }
    const binding = job.outputs?.mode?.match(
      /^\$\{\{ steps\.([\w-]+)\.outputs\.mode \}\}$/
    );
    if (!binding)
      throw new Error("Mode output must bind the actual gate step output");
    const modes = (outputs.get(binding[1]) ?? "")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("mode="))
      .map((line) => line.slice(5));
    if (modes.length > 1) throw new Error("Ambiguous publisher mode output");
    return { status, mode: modes[0] };
  } finally {
    if (
      !resolve(directory).startsWith(resolve(tmpdir(), "zivv-publisher-mode-"))
    )
      throw new Error("Unsafe publisher mode fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
}
function effectTrace(
  result: ReturnType<typeof runGate>,
  event: "push" | "pull_request"
) {
  const trace: string[] = [];
  if (result.status !== 0) return trace;
  if (condition(workflow.jobs.build, result.mode, event)) {
    trace.push("build");
    trace.push(
      ...workflow.jobs.build.steps.flatMap((step) =>
        step.uses && /configure-pages|upload-pages-artifact/.test(step.uses)
          ? [step.uses]
          : []
      )
    );
    if (condition(workflow.jobs.deploy, result.mode, event))
      trace.push(
        ...workflow.jobs.deploy.steps.flatMap((step) =>
          step.uses ? [step.uses] : []
        )
      );
  }
  return trace;
}

describe("legacy Pages publisher mode isolation", () => {
  it("makes mode classification an unprivileged prerequisite of every legacy effect job", () => {
    const gate = gateJob();
    expect(
      gate.permissions === undefined ? workflow.permissions : gate.permissions
    ).toSatisfy((permissions: Record<string, string>) =>
      Object.entries(permissions).every(
        ([key, value]) => key === "contents" && value === "read"
      )
    );
    expect(
      gate.steps.every(
        (step) => !step.uses && !step.if && !step["continue-on-error"]
      )
    ).toBe(true);
    expect(gate.outputs?.mode).toBe("${{ steps.mode.outputs.mode }}");
    for (const name of ["build", "deploy"]) {
      const job = workflow.jobs[name];
      expect(dependencies(job)).toContain(gateId);
      expect(expression(job.if ?? "")).toMatch(
        /needs\.publisher-mode\.outputs\.mode\s*==\s*['"]legacy['"]/
      );
      expect(job.if).not.toMatch(/always\(|failure\(|cancelled\(|\|\|/);
    }
    expect(dependencies(workflow.jobs.deploy)).toContain("build");
    expect(workflow.jobs.deploy.if).toContain(
      "github.ref == 'refs/heads/main'"
    );
    expect(workflow.jobs.deploy.if).toContain("github.event_name == 'push'");
  });

  it("reserves production concurrency for admitted legacy deployment jobs", () => {
    expect(workflow.concurrency?.group).not.toBe("pages");
    if (workflow.concurrency)
      expect(workflow.concurrency).toEqual({
        group: "legacy-pages-build",
        "cancel-in-progress": false,
      });
    expect(workflow.jobs.deploy.concurrency).toEqual({
      group: controlled.concurrency?.group,
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.deploy.concurrency?.group).toBe("pages");
  });

  it("requires the full ingestion suite before building or configuring/uploading Pages artifacts", () => {
    const steps = workflow.jobs.build.steps;
    const ingestion = steps.findIndex(
      (step) => step.run === "npm run test:ingestion"
    );
    expect(ingestion).toBeGreaterThan(-1);
    expect(steps[ingestion].if).toBeUndefined();
    expect(steps[ingestion]["continue-on-error"]).toBeUndefined();
    const build = steps.findIndex((step) =>
      step.run?.includes("NODE_ENV=production")
    );
    const configure = steps.findIndex((step) =>
      step.uses?.startsWith("actions/configure-pages@")
    );
    const upload = steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-pages-artifact@")
    );
    for (const index of [build, configure, upload]) {
      expect(index).toBeGreaterThan(ingestion);
      // Default success() must suppress every later build/publication step
      // when the complete ingestion command fails.
      expect(steps[index].if).toBeUndefined();
      expect(steps[index]["continue-on-error"]).toBeUndefined();
    }
  });

  const publishingValues = [
    "",
    "disabled",
    "enabled",
    "true",
    "false",
    "ENABLED",
    "enabled ",
    "unknown",
  ];
  const joinedValues = [
    "",
    "false",
    "true",
    "disabled",
    "TRUE",
    "true ",
    "unknown",
  ];
  const matrix = publishingValues.flatMap((publishing) =>
    joinedValues.map((joined) => [publishing, joined] as const)
  );
  it.each(matrix)(
    "classifies publishing=%j joined=%j before any Pages effects",
    (publishing, joined) => {
      const result = runGate(publishing, joined);
      const legacy =
        ["", "disabled"].includes(publishing) && ["", "false"].includes(joined);
      const enabled = publishing === "enabled" && joined === "true";
      if (legacy) {
        expect(result).toEqual({ status: 0, mode: "legacy" });
        const effects = effectTrace(result, "push");
        expect(effects).toContain("build");
        expect(
          effects.some((effect) => effect.includes("configure-pages"))
        ).toBe(true);
        expect(
          effects.some((effect) => effect.includes("upload-pages-artifact"))
        ).toBe(true);
        expect(effects.some((effect) => effect.includes("deploy-pages"))).toBe(
          true
        );
        const prEffects = effectTrace(result, "pull_request");
        expect(prEffects).toContain("build");
        expect(
          prEffects.some((effect) => effect.includes("deploy-pages"))
        ).toBe(false);
      } else {
        expect(result.status === 0).toBe(enabled);
        if (enabled) expect(result.mode).toBe("controlled");
        else expect(result.mode).not.toBe("legacy");
        expect(effectTrace(result, "push")).toEqual([]);
        expect(effectTrace(result, "pull_request")).toEqual([]);
      }
    }
  );
});
