import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("weekly delivery CLI activation boundary", () => {
  const script = join(process.cwd(), "scripts/run-weekly-import.js");
  function run(stage: string, extra: string[] = [], flags = {}) {
    return spawnSync(
      process.execPath,
      [script, "--run-id", "a".repeat(64), "--through", stage, ...extra],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...process.env,
          ZIVV_CONTROLLED_PUBLISHING: "",
          ZIVV_MANUAL_PUBLISHER_JOINED: "",
          GITHUB_TOKEN: "",
          ...flags,
        },
      }
    );
  }
  it.each(["verify", "acknowledge"])(
    "rejects %s before opening a candidate or operator store when disabled",
    (stage) => {
      const result = run(stage, ["--candidate", "missing-private-candidate"]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Verified weekly delivery stopped");
      expect(result.stderr).not.toContain("ENOENT");
      expect(result.stderr).not.toContain("missing-private-candidate");
    }
  );
  it("requires manual-publisher participation even with a token", () => {
    const secret = "test-token-must-not-appear";
    const result = run(
      "acknowledge",
      ["--candidate", "missing-private-candidate"],
      { ZIVV_CONTROLLED_PUBLISHING: "enabled", GITHUB_TOKEN: secret }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Verified weekly delivery stopped");
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("ENOENT");
  });
  it("does not accept a candidate on the maintained import-only path", () => {
    const result = run("load", ["--candidate", "missing-private-candidate"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--candidate requires --through verify or acknowledge"
    );
  });
  it("does not advertise an unsupported deploy-only resume", () => {
    const result = run("deploy");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported --through stage");
  });
});
