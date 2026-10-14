# Durable promotion ownership and artifact retention

Checkpoint for #35/#36/#39, stacked after #57. This adds optional publication
foundations. It does not activate dispatch, deploy a site, acknowledge a weekly
cutoff, configure credentials or replace the manual Friday path.

## Immutable artifact retention

`publication:retain` rechecks an exact payload against an independently trusted
candidate/source/purpose/base identity before any remote operation. Its fixed
source-repository reference is:

```text
refs/heads/zivv-candidate-artifacts/<exact payload commit SHA>
```

The payload stays outside served Pages branches. Only its `site/` bytes may
enter a future Pages upload. Recovery material never enters `zivv-test`.
The command saves a private intent before attempting the remote write, uses
an explicit non-force append, and observes that exact immutable reference
afterwards. A lost response may still mean the write succeeded. Missing or
inaccessible readback remains uncertain; a conflicting reference is never
replaced. An existing exact reference is reverified rather than written again.

After `npm run build:etl`, explicit operator commands are:

```powershell
node scripts/retain-publication-artifact.js retain `
  --transport github --payload-commit '<exact payload SHA>' `
  --candidate-id '<trusted candidate ID>' `
  --source-commit '<reviewed source commit>' `
  --purpose release --base /zivv/ `
  --intent-dir '<private operator intent directory outside Git>'

node scripts/retain-publication-artifact.js verify `
  --transport github --payload-commit '<exact payload SHA>' `
  --candidate-id '<trusted candidate ID>' `
  --source-commit '<reviewed source commit>' `
  --purpose release --base /zivv/
```

Neither command rebuilds or loads a recovery key. `verify` never writes a
reference. The explicit `bare-test` transport accepts only a real bare
repository under OS temporary storage; it is used for offline integration
tests, never an alternative production destination.

## Promotion control

Production and preview control references live in the authoritative source
repository, separately from Pages:

```text
refs/heads/zivv-promotion-control/production
refs/heads/zivv-promotion-control/preview
```

Each update is an immutable commit whose sole parent is the expected previous
head. Local updates use atomic reference compare-and-swap; remote updates
use non-force fast-forward appends. Competing children of the same expected
parent cannot both become the new head. A conflict stops the caller; it never
automatically refetches and reparents an obsolete request.

Preparation writes local objects only, so the caller can durably save the
attempted commit SHA, expected head, exact state bytes and timestamp before a
remote effect. Readback reconciles that attempt after a lost response. Source
code, payload, control, workflow, artifact and deployment identities remain
distinct.

An active owner survives process failure. Dispatch intent precedes dispatch;
an explicit compare-and-swap fences a planned/uncertain attempt before retry.
Delayed runs for that old attempt cannot be admitted. An admitted deployment
cannot be treated as absent merely because a request timed out. Verification
must match the exact deployment and public inventory. Ownership remains held
after verification until acknowledgement, or throughout public rollback and
its verification. Receipt replay is distinct from permission to repeat an
effect.

The deployment authorization getter requires the current admitted owner,
attempt and exact workflow run. An old receipt replay grants no permission to
deploy. Future effect jobs must also reconcile uncertain external deployments
before starting rollback; a timeout alone cannot establish that an earlier
Pages deployment stopped.

The bounded control snapshot references a native Git completion index.
Historical event commits and completion records remain reachable through Git
trees and parents. Request IDs are indexed by a SHA256 key with bounded tree
fanout; membership/nonmembership proofs prevent an old completed request from
being reclaimed or changed. Current control files do not copy cumulative
history or completed operations. This avoids an eventual state-file size limit
blocking Friday delivery.

Fresh-reader recovery verifies the legal Git parent chain once and is linear
in retained revisions. Warm readers use an immutable validated-ancestor cache
and verify new revisions incrementally. Current control bytes and their native
completion root are checked even when earlier ancestors are cached.

## Trust and activation boundary

The current Pages API reported production workflow publishing and preview
branch publishing on October 14, 2026. Both inherit the account domain:
`https://www.prodigic.com/zivv/` and `/zivv-test/`. The protocol binds those
existing destinations; future domain changes require a reviewed policy change.

Bootstrap requires retained and live-verified public rollback bytes. Legacy
public snapshots remain a distinct type; no candidate identity or authenticated
ledger pair is invented for them. Protocol tests use synthetic verification
receipts. They prove identity/state handling, not live site verification.

The transport permits only the source repository and dedicated control/artifact
references. It rejects endpoint rewrites and inherited Git object/index
overrides. Global Git configuration is excluded; provision reviewed credentials
in the selected runtime before activation. Restrict control writes to the
controller and enforce append-only operation. Local control writes reject
symbolic control references and a checkout whose HEAD resolves to that control
branch.

Actual workflow admission, deployment status reconciliation, live inventory
and browser checks, rollback restoration, acknowledgement, private recovery,
metadata queue, source acquisition, runtime/alerts and two observed Fridays
remain on the approved plan. The manual publication path must join the same
remote controller before automation becomes active. A successful retained
artifact or control append alone is not publication success.

## Verification

GPT-6.1 Sol high handled the state and Git transport lanes, with a separate
Sol high read-only audit. The audit found and corrected cumulative state growth,
ordinary HEAD alias mutation and changed terminal rollback-attempt replay.

- 34 state tests include 1,000 synthetic weekly completions, control records
  below 20 KB and ancient exact/changed replay. These use synthetic receipts,
  not observed Fridays.
- 16 Git tests include real competing processes, saved prepared intents,
  network-response uncertainty, symbolic-ref protections, native completion
  retention, aggressive garbage collection and fresh legal-history recovery.
- A real cross-module temporary-remote scenario uses the actual state parser
  and append validators through claim/fencing/retry/admission/completion and
  fresh recovery. Seven artifact tests include the actual CLI, durable intent
  persistence and rejection of a changed saved intent.
- The full ingestion regression gate passed all 60 files: 714 tests passed,
  one skipped, exit code 0, in 411.42 seconds. Strict application, ingestion
  and changed-test TypeScript, repository lint, formatting, production build
  and diff checks passed.

Tests changed only disposable stores/remotes; no GitHub control/artifact
reference, live source, catalog, cutoff, hosting setting or credential changed.
