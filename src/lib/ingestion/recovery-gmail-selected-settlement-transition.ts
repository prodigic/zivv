import type { Stats } from "node:fs";

/** Check only the pinned inode transition; callers must authenticate bytes,
 * authorize the exact paths, and hold both writer guards before mutation. */
export function assertSelectedLoadSettlementTransition(input: {
  candidate?: Stats;
  target?: Stats;
  dev: number;
  ino: number;
  targetWasPresent: boolean;
  started: boolean;
}): void {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_SETTLEMENT_TRANSITION");
  };
  const { candidate, target, dev, ino, targetWasPresent, started } = input;
  const exact = (item: Stats | undefined) =>
    !!item &&
    item.isFile() &&
    !item.isSymbolicLink() &&
    item.dev === dev &&
    item.ino === ino;
  if (!started && (!candidate || !!target !== targetWasPresent)) return fail();
  if (candidate && target) {
    if (
      !exact(candidate) ||
      !exact(target) ||
      candidate.nlink !== 2 ||
      target.nlink !== 2
    )
      return fail();
  } else if (candidate) {
    if (targetWasPresent || !exact(candidate) || candidate.nlink !== 1)
      return fail();
  } else if (!exact(target) || target!.nlink !== 1) return fail();
}
