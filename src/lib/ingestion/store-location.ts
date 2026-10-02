import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** Resolve one operator store for every checkout with the shared-store config. */
export function ledgerLocation(ledgerPath: string): {
  backend: "json" | "sqlite";
  path: string;
  directory: string;
} {
  const path = resolve(ledgerPath);
  const configPath = join(dirname(path), "store.json");
  if (!existsSync(configPath))
    return { backend: "json", path, directory: dirname(path) };
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    typeof config !== "object" ||
    config === null ||
    !("schemaVersion" in config) ||
    config.schemaVersion !== 1 ||
    !("backend" in config) ||
    config.backend !== "sqlite" ||
    !("namespace" in config) ||
    config.namespace !== "zivv"
  )
    throw new Error(`Unsupported ledger store configuration: ${configPath}`);
  const directory = resolve(
    process.env.ZIVV_LEDGER_HOME ||
      join(
        process.env.LOCALAPPDATA || join(homedir(), ".local", "state"),
        "Zivv",
        "ingestion"
      )
  );
  if (directory.startsWith("\\\\"))
    throw new Error("The shared SQLite ledger must be on a local disk.");
  return {
    backend: "sqlite",
    path: join(directory, "ledger.sqlite"),
    directory,
  };
}

/** Resolve from a project root without requiring a workspace-local ledger. */
export function projectLedgerLocation(root: string) {
  return ledgerLocation(join(root, "data", "ingestion", "ledger.json"));
}
