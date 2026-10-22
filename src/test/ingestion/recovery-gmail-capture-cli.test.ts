import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const privateInputs = [
  ["--file", join(tmpdir(), "missing-gmail-capture-capsule.enc")],
  ["--key", join(tmpdir(), "missing-gmail-capture-key.txt")],
  ["--receipt", join(tmpdir(), "missing-gmail-capture-retirement.json")],
  ["--destination", join(tmpdir(), "missing-gmail-capture-destination")],
  ["--npm-cli", join(tmpdir(), "missing-gmail-capture-npm-cli.js")],
] as const;

type FlagPair = readonly [string, string];
type RefusalCase = readonly [string, readonly FlagPair[]];

function requiredOptions(): FlagPair[] {
  return [...privateInputs, ["--batch-id", "a".repeat(64)]];
}

const cases: RefusalCase[] = [
  ["missing batch id", privateInputs],
  [
    "duplicate batch id",
    [...requiredOptions(), ["--batch-id", "b".repeat(64)]],
  ],
  [
    "repository selector",
    [...requiredOptions(), ["--repository", "owner/repo"]],
  ],
  ["run id", [...requiredOptions(), ["--run-id", "run-123"]]],
  [
    "workflow commit",
    [...requiredOptions(), ["--workflow-commit", "c".repeat(40)]],
  ],
  [
    "unknown token flag",
    [...requiredOptions(), ["--token", "synthetic-token"]],
  ],
  ["activation flag", [...requiredOptions(), ["--activate", "true"]]],
];

describe("operator recovery capture-gmail CLI argument refusal", () => {
  it.each(cases)(
    "rejects %s before opening private inputs",
    (_label, options) => {
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/operator-recovery.js"),
          "capture-gmail",
          ...options.flatMap(([name, value]) => [name, value]),
        ],
        { encoding: "utf8" }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"error":"INVALID_RECOVERY_ARGUMENTS"');
      expect(result.stderr).not.toContain("OPERATOR_RECOVERY_STOPPED");
    }
  );
});
