import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint/package.json"));
const { load } = eslintRequire("js-yaml") as { load(source: string): unknown };
interface Job {
  needs?: string[];
  if?: string;
  steps: {
    run?: string;
    if?: string;
    "continue-on-error"?: boolean;
    env?: Record<string, string>;
  }[];
}
const workflow = load(readFileSync(".github/workflows/test.yml", "utf8")) as {
  on: Record<string, { branches?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const required = [
  "unit-tests",
  "e2e-tests",
  "performance-tests",
  "lint-and-format",
  "build-test",
  "ingestion-tests",
  "workflow-validation",
];
const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";

describe("PR ingestion and semantic workflow gates", () => {
  it("runs on stacked PR targets with read-only repository permission", () => {
    expect(Object.hasOwn(workflow.on, "pull_request")).toBe(true);
    expect(workflow.on.pull_request?.branches).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("runs the full maintained ingestion command without tolerating failures", () => {
    const job = workflow.jobs["ingestion-tests"];
    expect(job.if).toBeUndefined();
    const step = job.steps.find((s) => s.run === "npm run test:ingestion");
    expect(step).toBeDefined();
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
  });

  it("pins and verifies the semantic validator before executing it", () => {
    const job = workflow.jobs["workflow-validation"];
    expect(job.if).toBeUndefined();
    const install = job.steps.find((s) => s.env?.ACTIONLINT_SHA256);
    expect(install?.env?.ACTIONLINT_SHA256).toBe(
      "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
    );
    expect(install?.run).toContain(
      "/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz"
    );
    expect(install?.run).toContain("sha256sum --check --strict");
    expect(job.steps.at(-1)?.run).toBe("actionlint -shellcheck= -pyflakes=");
    expect(job.steps.every((s) => !s.if && !s["continue-on-error"])).toBe(true);
  });

  const outcomes: [string, string, number][] = [
    ...required.map((job): [string, string, number] => [job, "failure", 1]),
    ["ingestion-tests", "cancelled", 1],
    ["workflow-validation", "skipped", 1],
    ["none", "success", 0],
  ];
  it.each(outcomes)(
    "summary enforces %s = %s",
    (affected, status, exitCode) => {
      const job = workflow.jobs["test-summary"];
      expect(job.if).toBe("always()");
      expect(job.needs).toEqual(required);
      const script = job.steps[0].run!.replace(
        /\$\{\{ needs\.([\w-]+)\.result \}\}/g,
        (_, name: string) => (name === affected ? String(status) : "success")
      );
      expect(script).not.toContain("${{");
      const result = spawnSync(bash, ["-e", "-o", "pipefail", "-c", script], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.error) throw result.error;
      expect(result.status).toBe(exitCode);
    }
  );
});
