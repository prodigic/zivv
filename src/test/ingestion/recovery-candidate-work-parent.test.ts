import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoveredCandidateWorkParent } from "../../lib/ingestion/recovery-import-admission.js";

// Exercise the consumer's scope contract without granting real recovery authority.
// Genuine encrypted-chain/new-host acceptance remains a separate native drill.
afterEach(() => vi.restoreAllMocks());

describe("recovered candidate work parent", () => {
  const operator = resolve("fixture-operator");
  const ordinaryParent = join(operator, "weekly-candidates");

  it("uses the exact selected mapped export parent for a namespaced chain", () => {
    const original = resolve(
      "deleted-host/weekly-candidates/r-selected/candidate-work-abc"
    );
    const mappedParent = join(ordinaryParent, "r-selected");
    const assertCurrent = vi.fn();
    const resolveDirectory = vi.fn((value: string) => {
      expect(value).toBe(original);
      return join(mappedParent, "candidate-work-abc");
    });
    vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue({
      active: true,
      operator,
      mode: "dispatch",
      assertCurrent,
      candidate: { workDirectory: original, resolveDirectory },
    });
    expect(recoveredCandidateWorkParent(ordinaryParent)).toBe(mappedParent);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(resolveDirectory).toHaveBeenCalledOnce();
  });

  it("preserves an ordinary direct-layout candidate parent", () => {
    const original = resolve("deleted-host/candidate-work-abc");
    vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue({
      active: true,
      operator,
      mode: "acknowledge",
      assertCurrent: vi.fn(),
      candidate: {
        workDirectory: original,
        resolveDirectory: (value: string) => {
          expect(value).toBe(original);
          return join(ordinaryParent, "candidate-work-abc");
        },
      },
    });
    expect(recoveredCandidateWorkParent(ordinaryParent)).toBe(ordinaryParent);
  });

  it("preserves the signed frozen-build namespace", () => {
    const parent = join(ordinaryParent, "r-building");
    vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue({
      active: true,
      operator,
      mode: "validate",
      assertCurrent: vi.fn(),
      build: { parent },
    });
    expect(recoveredCandidateWorkParent(ordinaryParent)).toBe(parent);
  });

  it("propagates exact mapped-inventory refusal", () => {
    vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue({
      active: true,
      operator,
      mode: "dispatch",
      assertCurrent: vi.fn(),
      candidate: {
        workDirectory: "selected-original",
        resolveDirectory: () => {
          throw new Error("INVALID_RECOVERY_CANDIDATE_LOCATION");
        },
      },
    });
    expect(() => recoveredCandidateWorkParent(ordinaryParent)).toThrow(
      "INVALID_RECOVERY_CANDIDATE_LOCATION"
    );
  });

  it("refuses a different default parent before mapping", () => {
    const resolveDirectory = vi.fn();
    vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue({
      active: true,
      operator,
      mode: "dispatch",
      assertCurrent: vi.fn(),
      candidate: { workDirectory: "selected-original", resolveDirectory },
    });
    expect(() =>
      recoveredCandidateWorkParent(join(operator, "elsewhere"))
    ).toThrow("RECOVERY_IMPORT_SCOPE_EXCEEDED");
    expect(resolveDirectory).not.toHaveBeenCalled();
  });

  it("checks the active scope before consulting its mapped parent", () => {
    const resolveDirectory = vi.fn();
    vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue({
      active: true,
      operator,
      mode: "dispatch",
      assertCurrent: () => {
        throw new Error("STALE_ADMISSION");
      },
      candidate: { workDirectory: "selected-original", resolveDirectory },
    });
    expect(() => recoveredCandidateWorkParent(ordinaryParent)).toThrow(
      "STALE_ADMISSION"
    );
    expect(resolveDirectory).not.toHaveBeenCalled();
  });

  it("leaves an ordinary invocation unchanged", () => {
    vi.spyOn(AsyncLocalStorage.prototype, "getStore").mockReturnValue(
      undefined
    );
    expect(recoveredCandidateWorkParent(ordinaryParent)).toBe(ordinaryParent);
  });
});
