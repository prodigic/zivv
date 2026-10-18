/** Explicit frozen-run entry points; the authenticated coordinator owns authority. */
export {
  resumeOperatorRecoveryFrozen,
  resumeOperatorRecoveryFrozenForTest,
  type RecoveryFrozenInput,
  type RecoveredFrozenReport,
} from "./recovery-import-admission.js";
