# Ledger guard

Requires the checkout's compiled `dist/lib/ingestion` modules and the current operator's existing backup key. Run `npm run build:etl` first. The helper reads SQLite and uses the repository's validated encryption format. It does not import, restore, or save the live ledger.

`capture --root ROOT` creates an encrypted baseline and a small metadata sidecar in the operator's private `consolidation` directory. `check --root ROOT --baseline PATH` compares one committed current revision with that baseline. Capture and check must target the same database and key. The sidecar binds the database path and baseline digest; keep both files together. No private event contents appear in console output.

## Expected changes

Write this JSON in the private baseline directory. An omitted allowlist means no record changes are permitted.

```json
{
  "schemaVersion": 1,
  "changes": [
    {
      "collection": "venues",
      "id": 42,
      "operation": "update",
      "fields": ["city", "updatedAtEpochMs"],
      "reason": "Correct the city using the reviewed official venue address"
    }
  ]
}
```

Collections: `events`, `artists`, `venues`, `runs`, `redirects`. IDs are entity `id`, receipt `runId`, or redirect `fromEventId`. Operations: `add`, `update`, `remove`. Updates require exact top-level changed field names; additions/removals omit `fields`. No wildcards or duplicate entries are accepted. Every expected change must occur; every actual change must be expected. Match field names to the real schema. This example is illustrative, not permission to edit venue 42.

For imports, review dry-run record IDs and fields to prepare the file. For duplicate merges, enumerate the removed event, survivor fields, and added redirect. Review nested source/conflict changes individually even though their top-level field is permitted. Permitting a field does not establish that its new value is correct.

The guard additionally rejects these changes even if allowlisted:

- Lost IDs without a valid merge redirect, or a retired ID returning as an event.
- Lost first-added origin/date/run/precision, except a merge preserving the earliest known contributor.
- Lost source identities, first observations, or decreasing last observations.
- Removed provenance conflicts or receipt history; rewritten receipt identity.
- Missing/cyclic redirects, removed prior redirects, changed migration metadata, or a decreasing revision.

The guard validates the ledger's schema and SQLite integrity using the repository modules before comparison. It detects record changes across the whole catalog, including artists and venues. Unchanged catalogs pass without count assumptions. It does not prove source accuracy, visual behavior, or import correctness; use the task's evidence and focused tests for those.

If a legitimate task intentionally changes protected history, investigate the invariant before proceeding. This guard has no bypass flag. Implement and review an explicit migration with appropriate tests instead of treating consolidation as rollback.
