import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { selectedLoadTemporaryTarget } from "../../lib/ingestion/recovery-gmail-selected-load-paths.js";

it("allows only actual installer, snapshot and report temporary families", () => {
  const root = resolve("fixture"),
    operator = join(root, "operator"),
    directory = join(root, "load"),
    report = join(root, "report.json"),
    snapshot = join(root, "snapshot.enc");
  const context = {
    operator,
    directory,
    report,
    snapshot,
    keyName: "backup-key.dpapi",
  };
  const one = ".123.0123456789abcdef.tmp",
    two = one + ".123.fedcba9876543210.tmp";
  const baseline = join(directory, "execution-baseline.json"),
    key = join(operator, context.keyName);
  expect(
    selectedLoadTemporaryTarget(
      join(
        directory,
        "execution-baseline.json-stage",
        "execution-baseline.json" + two
      ),
      context
    )
  ).toBe(baseline);
  expect(
    selectedLoadTemporaryTarget(
      join(directory, "key-stage", context.keyName + one),
      context
    )
  ).toBe(key);
  const chunk = "resume-snapshot-000.bin";
  expect(
    selectedLoadTemporaryTarget(
      join(directory, chunk + "-stage", chunk + two),
      context
    )
  ).toBe(join(directory, chunk));
  expect(selectedLoadTemporaryTarget(snapshot + one, context)).toBe(snapshot);
  expect(
    selectedLoadTemporaryTarget(
      report + ".123e4567-e89b-42d3-a456-426614174000.tmp",
      context
    )
  ).toBe(report);
  for (const wrong of [
    join(
      directory,
      "resume-snapshot-000.bin-stage",
      "resume-snapshot-001.bin" + one
    ),
    join(
      directory,
      "resume-snapshot-9999.bin-stage",
      "resume-snapshot-9999.bin" + one
    ),
    baseline + one,
    join(directory, "execution-baseline.json-stage", "execution-baseline.json"),
    join(operator, context.keyName + one),
    snapshot + two,
    report + ".------------------------------------.tmp",
    join(directory, "key-stage", "wrong" + one),
  ])
    expect(selectedLoadTemporaryTarget(wrong, context)).toBeUndefined();
});
