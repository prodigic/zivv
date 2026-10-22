import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const base = [
  "--file",
  "PRIVATE-CHAIN-NOT-TO-BE-READ",
  "--key",
  "PRIVATE-KEY-NOT-TO-BE-READ",
  "--destination",
  "PRIVATE-ROOT-NOT-TO-BE-CREATED",
  "--npm-cli",
  "PRIVATE-TOOL-NOT-TO-BE-EXECUTED",
];

describe("chain recovery command authority inputs", () => {
  it.each([
    ["prepare-chain", [...base, "--run-id", "substituted-run"]],
    ["prepare-chain", [...base, "--receipt", "substituted-receipt"]],
    ["resume-chain", [...base, "--repository", "UNREAD-REPOSITORY"]],
    [
      "resume-chain",
      [
        ...base,
        "--repository",
        "UNREAD-REPOSITORY",
        "--workflow-commit",
        "a".repeat(40),
        "--source-commit",
        "b".repeat(40),
      ],
    ],
  ])(
    "refuses caller-selected history or incomplete %s arguments before I/O",
    (command, args) => {
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/operator-recovery.js"), command, ...args],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, GITHUB_TOKEN: "DO-NOT-EXPOSE-TEST-TOKEN" },
        }
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      const report: { error: string } = JSON.parse(result.stderr.trim());
      expect(report.error).toBe("INVALID_RECOVERY_ARGUMENTS");
      expect(result.stderr).not.toContain("DO-NOT-EXPOSE-TEST-TOKEN");
      expect(result.stderr).not.toContain("PRIVATE-KEY-NOT-TO-BE-READ");
    }
  );
});
