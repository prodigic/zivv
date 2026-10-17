import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint/package.json"));
const { load } = eslintRequire("js-yaml") as {
  load(source: string): unknown;
};
interface Step {
  name: string;
  run?: string;
  uses?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, string>;
}
const source = readFileSync(".github/workflows/release.yml", "utf8");
const workflow = load(source) as {
  jobs: { release: { steps: Step[] } };
};
const steps = workflow.jobs.release.steps;
const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";

// Execute the actual workflow shell bodies with only external commands replaced.
// This exercises default failure propagation and ordering without remote effects.
function runRelease(failCommand: string, staleMain = false) {
  const directory = mkdtempSync(join(tmpdir(), "zivv-release-gate-"));
  const trace = join(directory, "trace");
  const prefix = `
record() { printf '%s\\n' "$1" >> "$TRACE"; [ "$1" != "$FAIL_COMMAND" ]; }
npm() { record "npm:$*"; }
npx() { record "npx:$*"; }
git() {
  record "git:$*" || return 42
  if [[ "$1" == rev-parse ]]; then
    if [[ "$2" == origin/main ]]; then printf '%s\\n' "$REMOTE_SHA";
    else printf '%s\\n' "$GITHUB_SHA"; fi
  fi
}
tar() {
  record "tar:$1" || return 42
  if [[ "$1" == -czf ]]; then printf 'fixture archive' > "$2"; fi
}
`;
  let failed = false;
  try {
    for (const step of steps) {
      if (failed && !step.if?.includes("always()")) continue;
      if (!step.run) {
        if (step.uses?.includes("create-release")) {
          if (!existsSync(trace)) throw new Error("Missing trace");
          return { released: true, trace: readFileSync(trace, "utf8") };
        }
        continue;
      }
      const script = step.run.replaceAll(
        "${{ needs.analyze-commits.outputs.new-version }}",
        "1.2.3"
      );
      const result = spawnSync(
        bash,
        ["-e", "-o", "pipefail", "-c", prefix + script],
        {
          cwd: directory,
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            TRACE: trace,
            FAIL_COMMAND: failCommand,
            NEW_VERSION: "1.2.3",
            RELEASE_ARCHIVE: "zivv-1.2.3.tar.gz",
            GITHUB_SHA: "a".repeat(40),
            REMOTE_SHA: (staleMain ? "b" : "a").repeat(40),
            GITHUB_OUTPUT: join(directory, "outputs"),
          },
        }
      );
      if (result.error) throw result.error;
      if (result.status !== 0 && !step["continue-on-error"]) failed = true;
    }
    return {
      released: false,
      trace: existsSync(trace) ? readFileSync(trace, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("legacy automated release gates", () => {
  it.each([
    "npm:ci",
    "npm:run lint",
    "npm:run format:check",
    "npm:run test:run",
    "npm:run test:ingestion",
    "npm:run build:full",
    "tar:-czf",
    "tar:-tzf",
  ])(
    "does not push a version or create a release after %s fails",
    (failure) => {
      const result = runRelease(failure);
      expect(result.trace).toContain(failure);
      expect(result.trace).not.toContain("git:push");
      expect(result.released).toBe(false);
    }
  );

  it("binds checkout and release tag to the intended tested commits", () => {
    expect(
      steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.ref
    ).toBe("${{ github.sha }}");
    expect(
      steps.find((s) => s.uses?.includes("create-release"))?.with?.commitish
    ).toBe("${{ steps.commit-version.outputs.commit }}");
  });

  it("pushes only after every gate and archive readback succeeds", () => {
    const result = runRelease("");
    expect(result.released).toBe(true);
    const push = result.trace.indexOf("git:push");
    for (const gate of [
      "npm:run lint",
      "npm:run format:check",
      "npm:run test:run",
      "npm:run test:ingestion",
      "npm:run build:full",
      "tar:-czf",
      "tar:-tzf",
    ]) {
      expect(result.trace.indexOf(gate)).toBeGreaterThan(-1);
      expect(result.trace.indexOf(gate)).toBeLessThan(push);
    }
  });

  it("rejects main drift without pushing or creating a release", () => {
    const result = runRelease("", true);
    expect(result.trace).not.toContain("git:push");
    expect(result.trace).not.toContain("git:commit");
    expect(result.released).toBe(false);
  });

  it("does not create a tag/release after a concurrent push rejection", () => {
    const result = runRelease("git:push origin HEAD:refs/heads/main");
    expect(result.trace).toContain("git:push origin HEAD:refs/heads/main");
    expect(result.released).toBe(false);
  });
});
