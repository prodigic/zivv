# Retained build execution tool identity

New reviewed builds retain the complete npm package identity before executing any
child command. This closes one prerequisite in [#78](https://github.com/prodigic/zivv/issues/78);
it does not admit or activate a restored installation.

```text
reviewed source + original npm CLI
  -> private execution-tools.json (before execution)
  -> check package + retained manifest before and after each child
  -> schema 2 application-build.json binds manifest SHA-256
  -> private candidate bundle and encrypted recovery capsule
```

The inventory records the original absolute CLI, npm version, package entrypoint,
and sorted relative file paths, sizes and SHA-256 hashes for the entire npm package
including its dependencies. It contains no file contents. The scanner accepts a
regular `bin/npm-cli.js` in an npm package, rejects links/hardlinks, unsafe or
case-aliased paths, `.git` and `.npmrc`, and bounds traversal at 10,000 entries and
64 MiB. It scans twice to detect changes during capture. Each command also checks
the retained manifest bytes. The version reported by npm must match the package
metadata before installation begins.

Schema 2 receipts require `executionToolSha256`. Private sealing, bundle reads and
recovery authentication require the exact corresponding `execution-tools.json`.
This includes retained source builds that have not produced a completed candidate.
Legacy schema 1 receipts remain readable and cannot claim this new provenance.
The strict receipt parser rejects missing schema 2 hashes and extra schema 1 keys.

The manifest stays outside the public site and publication payload. Public build
receipts expose its digest only. Their existing exact application-byte validation
continues without publishing the original npm path or inventory.

`validateNpmExecutionToolIdentity` checks retained metadata without filesystem
access. `verifyNpmExecutionTool` additionally checks a supplied physical package
copy against every retained file and version; only its physical location may
differ. The original manifest and its absolute logical CLI remain unchanged. This
supports future relocation without changing the hashed original build options.
Neither function installs tools or grants execution authority.

Offline inspection reports `retained-build-identities` when authenticated captured
builds contain this evidence; `not-retained` remains the legacy result. The report
does not claim that every run has a retained identity, or that a replacement npm
package has been provisioned or admitted.

Remaining requirements include binding the reviewed worker and Node runtime,
connecting resolved locations to active consumers, installing the working key,
fencing the old installation, reconciling canonical remote ownership, and completing
fresh-environment recovery drills. Worker inventory changes still require explicit
compatibility handling; never bypass `RUN_CONTEXT_CHANGED` or rewrite saved build
options. No scheduler, production mode or quarantine flag changes here.
