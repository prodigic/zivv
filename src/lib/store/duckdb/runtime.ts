import { createRequire } from "node:module";
import type { DuckDbRuntimeStatus } from "./types.js";

/**
 * Capability probe only. It does not install, download, or import DuckDB.
 * Callers should use the deterministic memory store when this reports false.
 */
export function detectDuckDbNodeApi(): DuckDbRuntimeStatus {
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@duckdb/node-api");
    return {
      packageName: "duckdb-node-api",
      available: true,
      reason: "@duckdb/node-api is resolvable from the current Node runtime",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "package is not resolvable";
    return {
      packageName: "duckdb-node-api",
      available: false,
      reason: `DuckDB build adapter unavailable: ${reason}`,
    };
  }
}
