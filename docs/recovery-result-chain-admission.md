# Admit a recaptured result on a new private installation

This optional recovery path is being implemented for #78/#38. It does not activate scheduling or authorize retiring an actual installation. Native two-host acceptance is required before operational use.

## Commands and identity

```text
npm run operator:recovery -- prepare-chain --file PRIVATE-HANDOFF/result.enc --key PRIVATE-KEY.txt --destination NEW-PRIVATE-ROOT --npm-cli REPLACEMENT-NPM-CLI.js
npm run operator:recovery -- resume-chain --file PRIVATE-HANDOFF/result.enc --key PRIVATE-KEY.txt --destination NEW-PRIVATE-ROOT --npm-cli REPLACEMENT-NPM-CLI.js --repository AUTHORITATIVE-CHECKOUT --workflow-commit REVIEWED-WORKFLOW-COMMIT
```

Use absolute private paths. The dispatch command obtains its GitHub credential from the existing `GITHUB_TOKEN` environment convention. No token belongs in the command line, output, repository or handoff document.

The encrypted chain selects its exact successor archive, retirement proof, run, build source and candidate. The caller cannot substitute another capsule, candidate, run ID, source commit or export path. The original and intermediate preparation receipts are historical evidence; a new destination needs its own standard preparation receipt and exact runtime validation.

## Boundaries

Preparation must authenticate the full chain, provision the exact successor through the existing quarantined runtime preparer, and bind the chain to that new physical installation. The fixed signed companion `NEW-PRIVATE-ROOT.chain-preparation.json` sits outside the pristine prepared tree. Preserve it with the new root; a missing/conflicting binding must not be bypassed by editing signed metadata. The new destination must be disjoint from both historical installations.

Candidate admission must reauthenticate chain, companion and runtime in the parent and retained worker, then use the existing candidate remote gate, private runner and publication retry machinery. Only the chain's exact authenticated run-specific export role maps to the replacement root. Ordinary direct-layout recovery keeps its existing rules. Historical npm paths retain their own hashes; the replacement tool must match the authenticated package contents and its own physical identity.

Fresh canonical authority is required at admission and every effect boundary. Captured remote heads alone grant no dispatch authority. Keep the same candidate, run and saved operation/attempt across retries; reconcile a lost dispatch response through the existing receipt lookup before another effect. This path stops at observed/pending dispatch. Live verification, acknowledgement and weekly cutoff advancement remain separate stages.

## Acceptance still required

A genuine test must create and recapture a real validated result, retain both retirement proofs, delete original/intermediate roots, prepare a physically distinct host from the same chain, and dispatch/retry that exact candidate with one remote effect. It must retain ledger/weekly/stage-artifact identity and refuse changed chain, companion, runtime, candidate, workflow, repository or canonical authority before effects.

No running test, pure format proof or green helper suite proves this composed workflow. Record the terminal native result, exact source revision and CI evidence. The current code covers a clean first build only; interrupted-build classes, arbitrary runtime/platform migration, preparation repair, off-machine retention, credentials, scheduling/monitoring and the two observed Friday editions remain gates in [the Friday delivery plan](friday-delivery-plan.md).

The composed `recovery-chain-host.test.ts` now defines the real two-installation drill, including deleted intermediate authority/tool paths, fresh workflow ancestry, exact crash-hook causes, changed companion/main refusals and a lost accepted response with one dispatch. Its loopback fixture contract has passed against the actual Pages transport; strict TypeScript/lint checks also pass. Execution evidence remains pending and must be recorded before this is treated as accepted recovery.
