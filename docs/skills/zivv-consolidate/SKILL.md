---
name: zivv-consolidate
description: Consolidate a Zivv chat's code and ingestion changes into the shared SQLite ledger, reconcile stale workspace copies, and check for data and feature regressions. Use when asked to consolidate, integrate, or reconcile a Zivv chat or worktree with the shared ledger, or verify its changes before publishing.
---

# Consolidate a Zivv chat

Complete the requested chat's work against the current shared ledger. Preserve concurrent work and prove that the requested behavior still works. This skill does not grant permission to message other chats, roll back the shared database, archive workspaces, or publish beyond existing user and repository authorization.

## 1. Establish the scope

- Read the repository's `AGENTS.md`, `docs/shared-ledger.md`, and documentation relevant to the changes. Inspect the actual code, commits, import reports, and source evidence. For another identified chat, use available chat reading tools; a summary is a starting point for investigation.
- Inspect Git status, branch ancestry, remote changes, and worktree paths. Preserve unrelated edits. Record the requested outcomes and concrete regression checks, including known failures before this work.
- Bring older code up to the shared-store implementation before running imports or ETL. Compile the ETL modules with `npm run build:etl`. Resolve the real operator directory with `ledger:status`; check any `ZIVV_LEDGER_HOME` override against the intended installation. An absent shared store is an error, never an empty catalog.

**Done when:** the chat's intended changes, source/base revision, target checkout, authoritative database, and checks are known.

## 2. Capture a protected baseline

Resolve this skill's directory as `SKILL_DIR`, and the checkout as `ROOT`. Run:

```text
node SKILL_DIR/scripts/ledger-regression.mjs capture --root ROOT
```

The helper writes an encrypted baseline under the permanent private operator directory and prints its path and revision. It does not change the database. Run `npm run ledger:backup` and `npm run ledger:verify` before a ledger mutation. Keep keys, clear ledger copies, private evidence, and reports outside Git and `public/`.

Prepare a small expected-change file using [the guard reference](references/ledger-guard.md). Each permitted record change needs specific fields and a reason. Derive it from the task and reviewed dry-run results **before applying changes**. For code-only work, omit the file to require an unchanged ledger.

**Done when:** a recoverable baseline exists and expected changes are explicit.

## 3. Reconcile the chat's work

- Integrate code with Git's three-way history and inspect conflicts against both intended behaviors. Regenerate derived public JSON from the shared ledger. Do not select an entire old worktree's generated catalog to resolve a conflict.
- Treat an old `ledger.json` or encrypted snapshot as evidence of proposed changes. There is no database-to-database merge command. Never restore a stale snapshot over the live store to consolidate a chat.
- For missing imports, recover original batches, run IDs, source identities, and observation times; preview through the maintained importer before applying. A new observation time can incorrectly reset historical dates added. If the original inputs cannot be recovered, prepare a narrow, reviewed reconciliation using existing transaction APIs that preserves original provenance. Do not invent dates, identities, or local artist origins.
- Use maintained import/repair commands with the shared writer transaction. Inspect conflicts and review items: a source disagreement may be logged while an update is accepted. Prove which venue, room, date, session, and artist identity the change concerns.
- For a duplicate merge, retain the earliest known first-added record, all source observations and conflicts, and a redirect from the retired ID. Preview ambiguous matches for review; do not automatically merge similar names.
- For an encrypted snapshot Git conflict, retain any unmerged historical evidence privately, then regenerate the snapshot from the canonical database with `ledger:backup`.

**Done when:** requested changes are integrated through the current persistence boundary and unexplained conflicts are resolved or clearly identified.

## 4. Check data and behavior

```text
node SKILL_DIR/scripts/ledger-regression.mjs check --root ROOT --baseline BASELINE --allowlist EXPECTED_CHANGES
```

Omit `--allowlist` when no changes are expected. A nonzero result blocks completion. Inspect every unexpected change. Do not widen the allowlist or recapture the baseline merely to hide a failure. If another writer changed the ledger, review that work and its receipts, reconcile the expected changes, and rerun against a freshly justified baseline before further writes. Never undo someone else's committed changes by restoring your baseline.

- Run focused ingestion tests for ledger changes and task-specific tests for the affected features. Repeat an import only when it is part of the task and verify that its replay creates no new IDs or changes to first-added dates.
- For exports, run ETL and verify the manifest's actual file byte sizes/checksums, entity references, redirects, and all required current/future chunks. Inspect weekly membership against persisted edition cutoffs and immutable dates added when weekly behavior is touched.
- Check the actual UI behavior affected by this chat. Examples: newsletter city labels and nearby event cities; the landing page's upcoming local artists and one-week venues; duplicate venue sections; aliases and duplicate event links. A ledger check alone does not verify these features.
- Run relevant type checks, lint, and a production build. A Vite build may clear `dist` ETL modules; use a separate ignored build directory or compile ETL again afterward. Distinguish pre-existing failures from new failures and record evidence for unresolved work.

**Done when:** the guard passes, requested behavior is demonstrated, and relevant quality checks pass or baseline failures are explicitly accounted for.

## 5. Finish and publish within authorization

- Follow repository instructions for issues, commits, and pushing the reviewed branch. Stage explicit files. Include only encrypted backups and approved public exports; inspect the staged diff for private data.
- Publish to the release branch when authorized by the user or applicable repository instructions. Fetch and reconcile advanced remote work; use ordinary pushes and verify the remote commit. Avoid force pushes.
- For a data release, refresh and verify the encrypted backup and compare its revision with the canonical ledger. `ledger:verify` verifies the snapshot, not equality with today's database. The final export and snapshot must reflect the same revision. If the store moved during export/verification, regenerate and recheck the affected artifacts. After three unsuccessful attempts, preserve reviewed work and report the need to coordinate writers; do not publish stale exports.
- Verify deployment completion, the live manifest, and affected behavior before reporting publication. Do not equate a successful local build or a running workflow with a deployed fix.

Report what was consolidated, the guard result and revision, behavior/tests checked, encrypted backup status, pushed commit, and deployment status if publishing was in scope. Identify any remaining blocker precisely. Leave chats and workspaces intact unless the user requested cleanup.
