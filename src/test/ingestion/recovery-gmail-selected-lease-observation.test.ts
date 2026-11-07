import { afterEach, expect, it, vi } from "vitest";
import { observeSelectedLoadLease } from "../../lib/ingestion/recovery-gmail-selected-lease-observation.js";
afterEach(() => vi.restoreAllMocks());
it("reports the real clock boundary without granting recovery authority", () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  expect(observeSelectedLoadLease(0)).toEqual({
    status: "released",
    expiresAtEpochMs: 0,
    observedAtEpochMs: 1000,
    loadAllowed: false,
  });
  expect(observeSelectedLoadLease(1001)).toEqual({
    status: "active",
    expiresAtEpochMs: 1001,
    observedAtEpochMs: 1000,
    loadAllowed: false,
  });
  expect(observeSelectedLoadLease(1000)).toEqual({
    status: "expired",
    expiresAtEpochMs: 1000,
    observedAtEpochMs: 1000,
    loadAllowed: false,
  });
  expect(() => observeSelectedLoadLease(-1)).toThrow();
  expect(() => observeSelectedLoadLease(Number.MAX_SAFE_INTEGER + 1)).toThrow();
});
