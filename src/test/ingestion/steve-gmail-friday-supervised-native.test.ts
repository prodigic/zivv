import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const prefix = "zivv-friday-supervised-native-";
const roots: string[] = [];
const command = resolve("scripts/steve-gmail.js");
const account = "synthetic-friday-native@example.invalid";
const env: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const credentialDirectory = join(root, "synthetic-credentials-never-created");
  const operatorDirectory = join(root, "synthetic-operator-never-created");
  const frame = {
    credentialDirectory,
    operatorDirectory,
    expectedAccountId: account,
    expectedEditionId: "2020-01-03",
    scanStartsAt: "2020-01-03T08:00:00.000Z",
  };
  return { root, credentialDirectory, operatorDirectory, frame };
}
function run(root: string, frame: unknown, budget = "10000") {
  return spawnSync(
    process.execPath,
    [command, "poll-friday-supervised", "--worker-budget-ms", budget],
    {
      cwd: root,
      env,
      input: typeof frame === "string" ? frame : JSON.stringify(frame),
      encoding: "utf8",
      timeout: 45_000,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    }
  );
}
function assertPrivateAndUntouched(
  result: ReturnType<typeof run>,
  f: ReturnType<typeof fixture>
) {
  expect(result.error).toBeUndefined();
  for (const value of [account, f.credentialDirectory, f.operatorDirectory]) {
    expect(result.stdout).not.toContain(value);
    expect(result.stderr).not.toContain(value);
  }
  expect(existsSync(f.credentialDirectory)).toBe(false);
  expect(existsSync(f.operatorDirectory)).toBe(false);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith(prefix)
    )
      throw Error("UNSAFE_TEST_CLEANUP");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "win32")(
  "packaged supervised Friday poll",
  () => {
    it("closes a historical window through the real native helper without opening private directories", () => {
      const f = fixture();
      const result = run(f.root, f.frame);
      assertPrivateAndUntouched(result, f);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "closed-for-review",
        editionId: "2020-01-03",
        reviewAtEpochMs: Date.parse("2020-01-06T08:00:00.000Z"),
      });
    }, 60_000);

    it.each(["0", "600001", "01", "+1", "1.0", "1e3"])(
      "refuses invalid worker budget %s effect-free",
      (budget) => {
        const f = fixture();
        const result = run(f.root, f.frame, budget);
        assertPrivateAndUntouched(result, f);
        expect(result.status).not.toBe(0);
      },
      60_000
    );

    it.each([
      "malformed JSON",
      "relative credential path",
      "relative operator path",
      "same directories",
      "extra field",
    ])(
      "refuses %s effect-free",
      (kind) => {
        const f = fixture();
        const frame =
          kind === "malformed JSON"
            ? "{"
            : kind === "relative credential path"
              ? { ...f.frame, credentialDirectory: "relative" }
              : kind === "relative operator path"
                ? { ...f.frame, operatorDirectory: "relative" }
                : kind === "same directories"
                  ? { ...f.frame, operatorDirectory: f.credentialDirectory }
                  : { ...f.frame, extra: "synthetic-private-extra" };
        const result = run(f.root, frame);
        assertPrivateAndUntouched(result, f);
        expect(result.stdout).not.toContain("synthetic-private-extra");
        expect(result.stderr).not.toContain("synthetic-private-extra");
        expect(result.status).not.toBe(0);
      },
      60_000
    );
  }
);
