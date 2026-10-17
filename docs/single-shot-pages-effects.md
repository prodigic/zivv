# Single-shot Pages effects

This extends [durable promotion control](durable-promotion-control.md) for
issues #35 and #36. It supplies state transitions and bounded API helpers;
importing these modules does not dispatch a workflow or deploy Pages.

A new dispatch intent carries a fresh nonce so competing same-time Git appends
cannot have the same identity. Pages creation similarly requires a numbered,
nonce-bound intent appended by the current admitted run. Only the caller that
wins that new CAS may issue its one creation POST. Reading a previously requested
state grants recovery permission, never another creation attempt.

Save the exact returned deployment ID before polling. Unknown creation or status
keeps ownership held. A definitive creation rejection can authorize a fresh
numbered intent; a timeout or lost response cannot. The helper's network deadline
starts after durable intent persistence, independently of Git latency. See the
[official API findings](research/pages-deployment-recovery.md) for recovery limits.

Durable receipts reject extra fields and unsafe destinations before public
output. Explicit Actions credentials reach Git through transient environment
headers scoped to the exact repository URL, with TLS verification enforced and
redirects disabled. Tokens never enter command arguments or repository configuration.

New creation and dispatch fields are optional in historical v1 records; parsing
old records does not inject defaults or change their hashes. Existing manual
importing and publishing remain available. Workflow integration, live
verification, rollback orchestration and cutoff acknowledgement are separate
checkpoints; this extension does not activate them.

The strict publication test types can be checked with
`node node_modules/typescript/bin/tsc --project tsconfig.publication-tests.json`.
