import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { compiledEtlDigest } from "../../lib/ingestion/source-build.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-worker-inventory-"));
  roots.push(root);
  for (const directory of ["lib/ingestion", "types", "utils", "data", "assets"])
    mkdirSync(join(root, "dist", directory), { recursive: true });
  writeFileSync(
    join(root, "dist/lib/ingestion/weekly-import-runner.js"),
    "export const version = 1;"
  );
  writeFileSync(join(root, "dist/utils/helper.js"), "export const helper = 1;");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel.startsWith("..") || !rel.startsWith("zivv-worker-inventory-"))
      throw new Error("Unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
describe("compiled worker runtime inventory", () => {
  it("ignores ordinary frontend/data rebuilds but binds worker helper bytes", () => {
    const root = fixture();
    const first = compiledEtlDigest(root, "worker");
    writeFileSync(join(root, "dist/data/events.json"), "new exported data");
    writeFileSync(join(root, "dist/assets/app.js"), "new frontend");
    expect(compiledEtlDigest(root, "worker")).toBe(first);
    writeFileSync(join(root, "dist/utils/helper.js"), "export const helper=2;");
    expect(compiledEtlDigest(root, "worker")).not.toBe(first);
  });
  it("requires the actual compiled worker entry point", () => {
    const root = fixture();
    rmSync(join(root, "dist/lib/ingestion/weekly-import-runner.js"));
    expect(() => compiledEtlDigest(root, "worker")).toThrow(
      "Compiled worker is missing"
    );
  });
});
