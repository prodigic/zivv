# Fail-closed legacy application releases

Checkpoint for [#39](https://github.com/prodigic/zivv/issues/39). The ordinary
`Automated Release` workflow remains separate from the optional controlled Friday
candidate publisher. This change does not activate the latter or advance any
weekly publication cutoff.

## Release ordering

The workflow checks out the exact triggering source SHA. It prepares the proposed
package version locally, then requires dependency installation, lint, formatting,
Storybook tests, the full ingestion configuration, application build and archive
creation/readback to pass. No gate may continue on error.

Only after those checks does it fetch main, require that main still equals the
triggering SHA, and push the package-version commit by ordinary fast-forward push.
It never rebases or force-pushes untested changes. Another main write after the
check rejects the push. The release tag explicitly targets the resulting version
commit, whose application/archive bytes were already validated locally.

Application release runs are serialized. A queued run based on an older main fails
closed; a later run can evaluate the newer source. A stale run must not be resumed
by bypassing the source check. Validation failures require fixing the source and
running the new source through all gates.

The archive contains `dist`, package manifests and README. A LICENSE file is
included only if present; this workflow does not invent licensing terms. Tar
creation failures, empty output and archive readback failures block mutation.

## Verification and limits

Regression tests execute the workflow's actual shell bodies with external commands
replaced by bounded local test functions. They inject gate/archive failures,
exercise a successful ordered release, reject main drift and reject concurrent
push failure, without remote effects. The original workflow fails these checks
because it pushes a version before gates and ignores failures.

Validate Actions contexts with actionlint as well as YAML parsing. Check both
Linux CI and the local Git Bash fixture path before relying on these gates.

The Test Suite now runs the full isolated ingestion command and checksum-pinned
actionlint 1.7.12 for every PR target, including stacked branches. Both jobs feed
the fail-closed Test Summary; failure, cancellation or skipping of a required job
fails that summary. Repository permissions are read-only. The Codecov action is
updated to a supported runner and input spelling so semantic validation passes.
Actionlint checks Actions syntax/context/action inputs; external shellcheck and
pyflakes are explicitly disabled. It is not a runtime workflow rehearsal.

This does not complete #39: repository branch-rule enforcement must be reconciled
with the maintained direct manual publication path before changing settings;
legacy Vitest collection/coverage remains #9; ordinary
Pages and version releases still run independently. Exact candidate promotion,
manual-publisher controller participation, verified weekly acknowledgement and
live/recovery rehearsals remain #31/#35/#36/#43. Failed release creation/upload
after a successful version push also requires explicit recovery; no code here
claims a remote multi-effect transaction or silently retries a tag publication.

The maintained manual Friday import/publication commands are unchanged. No
private catalog, raw email, recovery key or weekly state is loaded by this workflow.
