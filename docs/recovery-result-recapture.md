# Recapture a validated frozen recovery result

The optional `recapture-frozen` command retains the exact result of an admitted
frozen build and retires that intermediate quarantined installation. Native
composed acceptance is in progress. This documentation does not authorize an
actual installation retirement or unattended activation.

## Command and source state

```text
npm run operator:recovery -- recapture-frozen --file ORIGINAL.enc --receipt ORIGINAL.enc.retirement.json --key PRIVATE-KEY.txt --destination PREPARED-ROOT --npm-cli REPLACEMENT-NPM-CLI.js --repository AUTHORITATIVE-CHECKOUT --run-id ORIGINAL-RUN-ID --source-commit ORIGINAL-REVIEWED-COMMIT --out PRIVATE-HANDOFF/result.enc
```

Supply absolute local paths and the exact inputs used by `resume-frozen`. The
selected run must have its first eight stages succeeded and deployment,
verification and acknowledgement pending. The initial chain format requires a
clean first build; failed/retried/partial build histories remain unsupported.
Output and staging must be outside the entire prepared root, operator,
repository and all Git checkouts. Keep the separate recovery key privately.

The command discovers fixed preparation/admission/result metadata, verifies its
signatures and original bindings, checks actual runtime/dependency/source state,
and rechecks fresh canonical authority. It accepts no substituted report JSON,
artifact paths, activation bit or caller callback. The production CLI uses the
ordinary authoritative GitHub transport; temporary bare-Git transport exists
only in explicit test functions.

## Durable boundaries

1. Persist the signed `recovery-frozen-recapture.json` selection in the prepared
   root, binding original inputs, physical context and output path.
2. Own the journal guard, then the catalog transaction. Capture the actual
   successor and prove the bounded original-to-successor content transition.
3. Install the complete authenticated `result.enc.plan` durably and exclusively,
   retaining exact encrypted bytes before any successor fence can exist.
4. Install the plan's exact successor `operator-retired.json`. Ordinary import,
   journal and capture APIs remain closed on this installation.
5. Publish `result.enc` and deterministic `result.enc.receipt.json` from the plan.
   The returned report binds chain/run/candidate and output hashes, with
   `activationAllowed: false`.

Repeat the exact command after a lost response. Before fencing, reacquire locks
and compare the actual source with the retained plan; only capture time and
production lease bookkeeping may differ. Preserve the candidate, receipts and
encryption nonce. After fencing, verify the exact selection/plan/fence, physical
source and fresh canonical context, then repair private outputs from the plan.
Never recapture, acquire a source writer lease, install a working key, replace
the fence or unretire the source on this path. Missing selection, changed source
or dependency/preparation bytes, stale authority and conflicting outputs refuse.

Authenticated exclusive-install aliases may be cleaned only after byte/inode
proof. Partial staging evidence remains for diagnosis; do not delete it or edit
signed metadata to force a retry. This fences cooperating private installations;
an administrator removing all unfenced discoverable selection history is outside
the guarantee.

## Verification boundary

The coordinator's private capture scope grants no weekly-runner authority. Its
parent facade launches only the authenticated retained worker through the
existing module boundary, and checks the report against the retained plan.

The genuine native test performs original freeze/retirement/deletion, actual
npm/TypeScript/Vite recovery, sequential plan/fence/publication interruptions and
same-byte repairs. It checks pre-fence source/remote drift, post-fence preparation
and dependency drift, output-path conflicts and old-writer refusal. A running
test or its definition is not acceptance evidence; record the terminal result.

New-host preparation/admission of the [result chain](recovery-result-chain.md),
deletion of the intermediate host and same-candidate dispatch/retry remain
unfinished in #78/#38. Interrupted-build recovery, off-machine durability,
credentials, scheduling, monitoring and two observed Friday editions remain
separate gates in the [Friday delivery plan](friday-delivery-plan.md).
