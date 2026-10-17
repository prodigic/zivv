# Prepare the retained Friday runtime

This optional recovery operation installs the retained worker's production
dependencies and probes its quarantine guard. It is part of
[#78](https://github.com/prodigic/zivv/issues/78), not replacement activation or a
successful Friday recovery drill. The normal manual Friday path is unchanged.

## Retain a bootstrap tool profile

For future captures, pass the exact npm package entrypoint explicitly:

```text
npm run operator:recovery -- capture --root CHECKOUT --out PRIVATE_CAPSULE --npm-cli EXACT_NPM_PACKAGE/bin/npm-cli.js
npm run operator:recovery -- retire --root CHECKOUT --out PRIVATE_FINAL_CAPSULE --npm-cli EXACT_NPM_PACKAGE/bin/npm-cli.js
```

Read [planned retirement](operator-retirement.md) before using `retire`. Capture
does not retire the current installation. Only the retirement form produces the
portable retirement receipt required for the preparation operation below.

These commands produce a plaintext checkpoint schema v2 inside the existing
version-1 encrypted envelope. V2 requires the full npm package identity, including
its dependency closure, before any build has happened. Capture inventories the
tool without executing it and rechecks it under the journal/catalog writer locks
before finalization. The package bytes themselves are not embedded. Retain an
exact independently provisioned package copy along with the exact Node runtime;
the same npm version string alone is insufficient.

Existing captures without `--npm-cli` remain v1 and support offline recovery
inspection. They cannot silently acquire a bootstrap identity. A retirement retry
with the option verifies the retained identity against the supplied physical
copy; it cannot upgrade a v1 final capsule. Retrying without the option continues
to authenticate the existing retirement evidence.

## Prepare and verify

After the approved retirement prerequisites have been satisfied, provision the
exact Node/ICU executable, reviewed compiled worker, lockfile and npm package on
the replacement environment. Then run:

```text
npm run operator:recovery -- prepare-runtime --file PRIVATE_FINAL_CAPSULE --receipt PRIVATE_FINAL_CAPSULE.retirement.json --key PRIVATE_BASE64_RECOVERY_KEY --destination NEW_PRIVATE_ROOT --npm-cli REPLACEMENT_NPM_PACKAGE/bin/npm-cli.js
npm run operator:recovery -- verify-prepared-runtime --file PRIVATE_FINAL_CAPSULE --receipt PRIVATE_FINAL_CAPSULE.retirement.json --key PRIVATE_BASE64_RECOVERY_KEY --destination NEW_PRIVATE_ROOT --npm-cli REPLACEMENT_NPM_PACKAGE/bin/npm-cli.js
```

Preparation authenticates the capsule/retirement binding and exact local runtime
before staging. It refuses a different executor or package closure, even if a
package version agrees. The destination is new, local and outside Git. Staging
reconstructs and inspects the actual catalog, journal and retained files first.

Inside quarantine, preparation runs the verified npm with `--version`, then
`ci --ignore-scripts --omit=dev --no-audit --no-fund`. It uses separate empty user
and global npm configurations, private HOME/TMP/cache and an explicit npm registry.
Ambient tokens, npm options and Node loader options are not inherited. Lifecycle
scripts are disabled. Dependency downloads still require registry access; a
capsule is not an offline npm mirror. Application-build development dependencies
remain a separate source-build concern.

A controlled Node module hook fences both CommonJS and ESM resolution to the
staged checkout and verified npm package. An import resolved from a parent
installation is refused before evaluating that module, even if an ordinary Node
probe would otherwise reach the quarantine guard.

The actual retained `runWeeklyImport` module must import successfully and refuse
a probe with `RECOVERY_INSTALLATION_NOT_ACTIVATED` before journal ownership or
import effects. Every baseline staged path and byte must remain unchanged; new
files are allowed only in the private bootstrap and installed dependency trees.
Runtime/tool checks repeat around execution. Children have bounded output and a
ten-minute timeout; their raw diagnostics are not copied into public CLI output.
Timeout/output-limit failure rejects independently of pipe closure and forcibly
stops the owned child (its process group on POSIX). Windows root termination does
not claim to cancel arbitrary descendants; inspect/drain failed private staging
before reuse of the machine. No failed preparation can issue a success receipt.

On success, a private `prepared-runtime.json` binds the original archive,
retirement receipt, bootstrap tool identity, physical npm CLI, destination and complete
prepared-tree digest with HMAC-SHA-256 using the existing recovery key. The tree
inventory includes directories, dependencies, bootstrap files and restored
databases. Hardlinks, directory links, case aliases and Git metadata are refused.
Relative dependency links are allowed only when both their lexical and resolved
targets stay inside `checkout/node_modules`.

Verification authenticates the receipt, checks the current runtime and npm copy,
and recomputes the exact tree inventory without executing a child or opening SQL.
Repeated preparation of an exactly completed destination only verifies it. A
partial or modified destination is refused, never repaired or reinstalled in
place. Preserve failed evidence and use a new destination after investigation.
Moving the prepared tree or its physical npm package requires a new preparation;
an identical tool copy at a different path cannot reuse the old loader binding.

## Remaining boundary

The recovery marker remains `staged`, `activationAllowed=false`. No working key
is installed, no Git checkout is created, no source is imported, and no remote
publication or scheduler is enabled. A preparation receipt is evidence of a
specific quarantined tree; it is not an active context or an activation token.
Legitimate future database writes change that tree. The separate
[same-run import admission](recovery-import-admission.md) authenticates a bounded
resume through load without weakening this pristine-tree verifier.

Replacement admission still needs physical/logical path consumer integration,
working-key installation, authoritative Git ancestry, old-host fencing and
canonical remote reconciliation. The four fresh-environment resume classes,
off-machine durability, scheduler/notification setup and observed Friday runs
remain open. Never delete the quarantine marker or bypass `RUN_CONTEXT_CHANGED`
to substitute for those gates.
