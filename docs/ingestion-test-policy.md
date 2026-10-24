# Ingestion and recovery test scope

Operator direction, October 22, 2026: reduce routine recovery-test overhead while
preserving the full [Friday delivery requirements](friday-delivery-plan.md).

## Three levels of evidence

1. **Routine gate:** import/preflight, reconciliation, receipt replay, shared-store
   integrity, encrypted backup, weekly membership and normal publication behavior.
   Run the checks affected by a change, including type, lint and workflow checks.
2. **Targeted recovery checks:** exercise the changed recovery boundary and its
   refusal/retry cases. Reuse retained diagnostics and exact terminal results;
   do not restart an observed job merely because an observation timed out.
3. **Full recovery rehearsal:** machine loss, deleted/intermediate hosts, crash
   matrices and composed multi-batch restoration. Run at recovery milestones and
   before unattended activation, with explicit evidence for the affected contract.

The first two levels cannot prove the third. A manual Friday release does not
require every disaster-recovery rehearsal to pass, but its actual import,
publication and live-verification requirements still apply. Unverified recovery
requirements remain open under #78, #96, #106 and #38.

## Current implementation and next changes

The existing ingestion command and GitHub workflows still run the complete suite.
This document records the intended separation; it does not silently remove tests
or change the current workflow gates. Define explicit test manifests and verify
their membership before changing those gates. Keep every test assigned and retain
an explicit full-suite entry point. Record skipped and unresolved checks.

The main test workflow and Pages build currently repeat the ingestion suite.
Sharing a result is appropriate only when the prerequisite result proves the
required checks for the exact reviewed source commit and workflow policy. Do not
replace that binding with the latest successful run, a local report, or a result
from a different commit. A failed required publication check remains a blocker
until the gate is satisfied or its policy is explicitly changed and verified.

## Cost and diagnostics

Test execution consumes machine/CI resources. Model tokens are spent on agent
analysis, code and tool interactions, not by the local test process itself.
Do not attribute token or monetary savings without corresponding telemetry.
Prefer smaller-model inventories and fixtures, with Sol high handling authority
decisions, integration and sampled audits.

Capture phase timings and native failure reasons before repeating a slow case.
Preserve failed private fixtures without placing their contents in Git. Change
timeouts only when justified by measured work; do not use larger limits to hide a
missing terminal result or an unknown blocked operation.
