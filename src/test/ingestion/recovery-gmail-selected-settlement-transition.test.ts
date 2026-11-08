import {
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertSelectedLoadSettlementTransition } from "../../lib/ingestion/recovery-gmail-selected-settlement-transition.js";

it("accepts only the pinned inode transition after guarded settlement starts", () => {
  const root = mkdtempSync(join(tmpdir(), "zivv-settlement-transition-"));
  try {
    const candidate = join(root, "candidate"),
      target = join(root, "target"),
      foreign = join(root, "foreign");
    writeFileSync(candidate, "authenticated");
    const initial = lstatSync(candidate);
    const observe = (targetWasPresent: boolean, started: boolean) =>
      assertSelectedLoadSettlementTransition({
        candidate: (() => {
          try {
            return lstatSync(candidate);
          } catch {
            return undefined;
          }
        })(),
        target: (() => {
          try {
            return lstatSync(target);
          } catch {
            return undefined;
          }
        })(),
        dev: initial.dev,
        ino: initial.ino,
        targetWasPresent,
        started,
      });
    expect(() => observe(false, false)).not.toThrow();
    linkSync(candidate, target);
    expect(() => observe(false, false)).toThrow();
    expect(() => observe(false, true)).not.toThrow();
    expect(() => observe(true, false)).not.toThrow();
    linkSync(candidate, foreign);
    expect(() => observe(true, true)).toThrow();
    unlinkSync(foreign);
    unlinkSync(target);
    expect(() => observe(true, true)).toThrow();
    linkSync(candidate, target);
    unlinkSync(candidate);
    expect(() => observe(true, false)).toThrow();
    expect(() => observe(true, true)).not.toThrow();
    unlinkSync(target);
    expect(() => observe(true, true)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
