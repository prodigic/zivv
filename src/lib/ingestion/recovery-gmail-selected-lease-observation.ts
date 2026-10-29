/** Time-sensitive observation only. Acquisition must independently check the
 * actual owner under the journal writer transaction; this grants no authority. */
export function observeSelectedLoadLease(expiresAtEpochMs: number) {
  const observedAtEpochMs = Date.now();
  if (
    !Number.isSafeInteger(expiresAtEpochMs) ||
    expiresAtEpochMs < 0 ||
    !Number.isSafeInteger(observedAtEpochMs) ||
    observedAtEpochMs < 0
  )
    throw Error("INVALID_SELECTED_LOAD_LEASE_OBSERVATION");
  return {
    status:
      expiresAtEpochMs === 0
        ? ("released" as const)
        : expiresAtEpochMs > observedAtEpochMs
          ? ("active" as const)
          : ("expired" as const),
    expiresAtEpochMs,
    observedAtEpochMs,
    loadAllowed: false as const,
  };
}
