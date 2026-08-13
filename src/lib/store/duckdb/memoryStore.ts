import { InMemoryCanonicalState } from "./canonical.js";
import type { BuildStore, CanonicalState, StagedSnapshot } from "./types.js";

/**
 * Deterministic fallback used until the repository declares a supported
 * @duckdb/node-api runtime. It models the same staging/canonical semantics so
 * snapshot contracts can run without downloading a native package.
 */
export class DeterministicMemoryBuildStore implements BuildStore {
  readonly backend = "deterministic-memory";
  private readonly state = new InMemoryCanonicalState();

  async initialize(): Promise<void> {
    // The in-memory implementation has no external resources to initialize.
  }

  async applySnapshot(snapshot: StagedSnapshot): Promise<{ inserted: number; updated: number; replayed: boolean }> {
    return this.state.apply(snapshot);
  }

  async readState(): Promise<CanonicalState> {
    return this.state.read();
  }

  async close(): Promise<void> {
    // The in-memory implementation has no external resources to close.
  }
}
