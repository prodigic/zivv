import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectRecoveryInstalledFile,
  installRecoveryIntent,
} from "../../lib/ingestion/encrypted-backup.js";

const fixturePrefix = "zivv-gmail-capture-installer-stage-";
const intent = Buffer.from('{"fixture":"capture-intent"}\n');

function createStagePath(
  staging: string,
  target: string,
  nested = false
): string {
  const suffix = `${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const first = join(staging, `${basename(target)}.${suffix}`);
  return nested
    ? `${first}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    : first;
}

function fileIdentity(path: string): { dev: number; ino: number } {
  const stat = statSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

describe("recovery Gmail capture installer stage repair", () => {
  let base: string;
  let target: string;
  let staging: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), fixturePrefix));
    const operator = join(base, "operator");
    staging = join(base, "staging");
    mkdirSync(operator);
    mkdirSync(staging);
    target = join(operator, "admission.json");
  });

  afterEach(({ task }) => {
    if (task.result?.state === "fail") {
      console.error(`Preserved failed installer-stage fixture at ${base}`);
      return;
    }
    const absolute = resolve(base);
    const relativePath = relative(resolve(tmpdir()), absolute);
    if (
      !relativePath.startsWith(fixturePrefix) ||
      relativePath.includes(sep) ||
      relativePath === ".."
    )
      throw new Error("Unsafe installer-stage fixture cleanup");
    rmSync(absolute, { recursive: true, force: true });
  });

  it("adopts one complete stage at the same inode and removes its name", () => {
    const stage = createStagePath(staging, target);
    writeFileSync(stage, intent, { flag: "wx", mode: 0o600 });
    const stageIdentity = fileIdentity(stage);

    expect(installRecoveryIntent(target, intent, staging)).toEqual(intent);
    expect(fileIdentity(target)).toEqual(stageIdentity);
    expect(existsSync(stage)).toBe(false);
    expect(readFileSync(target)).toEqual(intent);
  });

  it("adopts a nested two-suffix complete stage at the same inode", () => {
    const stage = createStagePath(staging, target, true);
    writeFileSync(stage, intent, { flag: "wx", mode: 0o600 });
    const stageIdentity = fileIdentity(stage);

    expect(installRecoveryIntent(target, intent, staging)).toEqual(intent);
    expect(fileIdentity(target)).toEqual(stageIdentity);
    expect(existsSync(stage)).toBe(false);
    expect(readFileSync(target)).toEqual(intent);
  });

  it("leaves an unrelated target's stage name unchanged", () => {
    const unrelated = join(
      staging,
      `result.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    const unrelatedBytes = Buffer.from('{"fixture":"other-target"}\n');
    writeFileSync(unrelated, unrelatedBytes, { flag: "wx", mode: 0o600 });

    expect(installRecoveryIntent(target, intent, staging)).toEqual(intent);
    expect(readFileSync(target)).toEqual(intent);
    expect(readFileSync(unrelated)).toEqual(unrelatedBytes);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("removes an owned hardlink alias while retaining the canonical bytes", () => {
    installRecoveryIntent(target, intent, staging);
    const alias = createStagePath(staging, target);
    linkSync(target, alias);

    expect(installRecoveryIntent(target, intent, staging)).toEqual(intent);
    expect(existsSync(alias)).toBe(false);
    expect(readFileSync(target)).toEqual(intent);
    expect(statSync(target).nlink).toBe(1);
  });

  it("removes a matching independent candidate and preserves canonical inode", () => {
    installRecoveryIntent(target, intent, staging);
    const canonicalIdentity = fileIdentity(target);
    const candidate = createStagePath(staging, target);
    writeFileSync(candidate, intent, { flag: "wx", mode: 0o600 });

    expect(installRecoveryIntent(target, intent, staging)).toEqual(intent);
    expect(fileIdentity(target)).toEqual(canonicalIdentity);
    expect(existsSync(candidate)).toBe(false);
    expect(readFileSync(target)).toEqual(intent);
  });

  it("refuses two matching complete stages and preserves both without a target", () => {
    const first = createStagePath(staging, target);
    const second = createStagePath(staging, target, true);
    writeFileSync(first, intent, { flag: "wx", mode: 0o600 });
    writeFileSync(second, intent, { flag: "wx", mode: 0o600 });

    expect(() => installRecoveryIntent(target, intent, staging)).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(first)).toEqual(intent);
    expect(readFileSync(second)).toEqual(intent);
  });

  it("refuses a partial stage and preserves it without a target", () => {
    const stage = createStagePath(staging, target);
    const partial = intent.subarray(0, intent.length - 2);
    writeFileSync(stage, partial, { flag: "wx", mode: 0o600 });

    expect(() => installRecoveryIntent(target, intent, staging)).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(stage)).toEqual(partial);
  });

  it("refuses a conflicting complete stage and preserves it without a target", () => {
    const stage = createStagePath(staging, target);
    const conflicting = Buffer.from('{"fixture":"different"}\n');
    writeFileSync(stage, conflicting, { flag: "wx", mode: 0o600 });

    expect(() => installRecoveryIntent(target, intent, staging)).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(stage)).toEqual(conflicting);
  });

  it("refuses a different canonical value and preserves canonical and candidate", () => {
    const original = Buffer.from('{"fixture":"original"}\n');
    installRecoveryIntent(target, original, staging);
    const stage = createStagePath(staging, target);
    writeFileSync(stage, intent, { flag: "wx", mode: 0o600 });

    expect(() => installRecoveryIntent(target, intent, staging)).toThrow();
    expect(readFileSync(target)).toEqual(original);
    expect(readFileSync(stage)).toEqual(intent);
  });

  it("refuses a candidate with an external hardlink and preserves both names", () => {
    const stage = createStagePath(staging, target);
    const external = join(base, "external-hardlink");
    writeFileSync(stage, intent, { flag: "wx", mode: 0o600 });
    linkSync(stage, external);

    expect(() => installRecoveryIntent(target, intent, staging)).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(stage)).toEqual(intent);
    expect(readFileSync(external)).toEqual(intent);
    expect(statSync(stage).nlink).toBe(2);
  });

  it("observes a complete orphan without changing it", () => {
    const candidatePath = createStagePath(staging, target);
    writeFileSync(candidatePath, intent, { flag: "wx", mode: 0o600 });
    const before = fileIdentity(candidatePath);

    const observed = inspectRecoveryInstalledFile(target, staging);

    expect(observed.target).toBeNull();
    expect(observed.candidate).toMatchObject({
      path: candidatePath,
      bytes: intent,
      ...before,
      nlink: 1,
    });
    expect(fileIdentity(candidatePath)).toEqual(before);
    expect(readFileSync(candidatePath)).toEqual(intent);
    expect(existsSync(target)).toBe(false);
  });

  it("observes canonical and exact hardlink alias without changing either", () => {
    installRecoveryIntent(target, intent, staging);
    const candidatePath = createStagePath(staging, target);
    linkSync(target, candidatePath);
    const targetIdentity = fileIdentity(target);
    const candidateIdentity = fileIdentity(candidatePath);

    const observed = inspectRecoveryInstalledFile(target, staging);

    expect(observed.target).toMatchObject({
      path: target,
      bytes: intent,
      ...targetIdentity,
      nlink: 2,
    });
    expect(observed.candidate).toMatchObject({
      path: candidatePath,
      bytes: intent,
      ...candidateIdentity,
      nlink: 2,
    });
    expect(fileIdentity(target)).toEqual(targetIdentity);
    expect(fileIdentity(candidatePath)).toEqual(candidateIdentity);
    expect(existsSync(candidatePath)).toBe(true);
    expect(statSync(target).nlink).toBe(2);
  });

  it("rejects an oversized candidate without changing it", () => {
    const candidatePath = createStagePath(staging, target);
    const oversized = Buffer.from("exceeds-limit");
    writeFileSync(candidatePath, oversized, { flag: "wx", mode: 0o600 });
    const before = fileIdentity(candidatePath);

    expect(() => inspectRecoveryInstalledFile(target, staging, 4)).toThrow();
    expect(fileIdentity(candidatePath)).toEqual(before);
    expect(readFileSync(candidatePath)).toEqual(oversized);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses and preserves a matching candidate below a Git ancestor", () => {
    mkdirSync(join(base, ".git"));
    const candidatePath = createStagePath(staging, target);
    writeFileSync(candidatePath, intent, { flag: "wx", mode: 0o600 });

    expect(() => installRecoveryIntent(target, intent, staging)).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(candidatePath)).toBe(true);
    expect(readFileSync(candidatePath)).toEqual(intent);
  });

  it("refuses three hardlinks and preserves the canonical and both aliases", () => {
    installRecoveryIntent(target, intent, staging);
    const stage = createStagePath(staging, target);
    const external = join(base, "external-hardlink");
    linkSync(target, stage);
    linkSync(target, external);

    expect(() => installRecoveryIntent(target, intent, staging)).toThrow();
    expect(readFileSync(target)).toEqual(intent);
    expect(readFileSync(stage)).toEqual(intent);
    expect(readFileSync(external)).toEqual(intent);
    expect(statSync(target).nlink).toBe(3);
    expect(fileIdentity(stage)).toEqual(fileIdentity(target));
    expect(fileIdentity(external)).toEqual(fileIdentity(target));
  });
});
