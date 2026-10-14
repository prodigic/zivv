# Audited Steve List preflight

Checkpoint #10 adds optional deterministic preparation before the maintained importer. Existing `validate`, `merge` and import commands remain available. Preflight reads the canonical ledger for validation but does not import, prepare a weekly edition, refresh a backup or publish anything.

## Operator commands

Use Node 24.19.0+ and the intended private operator store. Set `ZIVV_LEDGER_HOME` explicitly if the shell/sandbox selects a different local application directory. Start with `npm run ledger:status`; missing authoritative storage is an error.

The input is the decoded UTF-8 plain-text email body, not raw MIME. Preserve original MIME separately when acquiring mail. The output directory must be permanent private storage outside all Git checkouts and public delivery folders; the command rejects checkout/Git paths and artifact links and restricts the artifact directory to the current operator.

```text
npm run preflight:steveslist -- --file <private-decoded-source> --output-dir <private-operator-preflight-directory>
```

Preflight emits a content/configuration/ledger-revision-addressed directory containing:

- `raw.txt`: exact original input bytes, including CRLF, BOM and delivery/footer text.
- `report.json`: private line/row accounting, source and rules hashes, ledger revision, corrections, excluded programming names, exact-duplicate links and blocking diagnostics.
- `prepared.txt`: retained corrected listings with the dated issue header; present only when validation succeeds.

Exit zero means an importable prepared batch was produced, not that reconciliation or publication is approved. Exit one with a report means review is required and no prepared batch is emitted. Invalid UTF-8 is archived with a failure report and never accepted. Configuration, filesystem or missing-ledger failures may occur before artifacts are produced; the original input is never overwritten. Terminal output contains paths/hashes/counts, not source text or subscriber details.

Every physical source line receives a disposition. Wrapped rows are collapsed before configured corrections are applied. Only exact corrected-row duplicates are removed; differing bills that the importer would merge block preparation. Known programming-only rows use the same performer parser/classifier as ETL. Mixed performer/programming bills remain, with excluded names recorded. Impossible dates, unknown date/weekday forms, dated listings outside the listing section, unclassified post-venue continuations, and unknown malformed rows block the batch. Unknown formatting needs explicit review/configuration, not a guessed exclusion.

Preflight uses current `data/line-corrections.json` and `data/venue-aliases.json`. Corrections must be idempotent when the maintained importer applies them again. Exact source/configuration/ledger identity retries reuse byte-identical artifacts; mismatched/corrupted artifacts fail rather than being silently overwritten. Writes use durable temporary files and atomic rename. A different ledger revision produces a separate validation artifact; it does not change the prepared batch's import receipt identity merely because validation was repeated.

Review the report and reconcile against the current catalog:

```text
npm run import:steveslist -- --file <artifact-directory>/prepared.txt --dry-run
npm run import:steveslist -- --file <artifact-directory>/prepared.txt
```

Inspect unresolved core identities before committing. The existing dry-run may refresh encrypted backup files, although it does not commit catalog changes. Repeated import of identical prepared content uses the existing receipt and preserves IDs/first-added dates. Preflight does not attach raw-source provenance to the durable import automatically; retain the private report and raw/prepared hashes together. #31 will bind these identities in the run journal.

Continue through the [manual stage commands](weekly-stage-contracts.md#maintained-manual-commands) for weekly preparation, export, backup verification, publication and live checks. If this optional preflight blocks unfamiliar formatting, use the existing audited manual preparation path with explicit row accounting; never bypass unresolved core source errors.

## Verification

Synthetic tests exercise unindented wraps, corrections spanning lines and short weekday tokens, exact duplicates, mixed/only programming bills, calendar errors, missing venues, numeric performer names, footer/club-section source loss, invalid UTF-8, private-path/junction rejection, corrupted artifacts, deterministic retries and real importer receipt replay. Tests use isolated temporary stores; no real source or private report belongs in the repository.

This command is not automatic source acquisition (#30), the resumable orchestrator (#31), or an activation of Friday scheduling. See the [delivery plan](friday-delivery-plan.md).
