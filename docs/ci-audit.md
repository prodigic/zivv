# CI and quality-gate audit

Audit date: 2026-08-13

This is an inventory for the reorganization. It records current workflow behavior and the changes required before the DuckDB migration is considered complete.

## Current workflows

| Workflow | Trigger | Current role | Node version |
|---|---|---|---:|
| `deploy.yml` | pushes/PRs for deployment branches | lint, format, type check, unit tests, Vite build, Pages deploy | 20 |
| `test.yml` | pushes/PRs to `main`/`develop` | unit, E2E, performance, lint/format, production build | 20 |
| `etl.yml` | data/ETL changes or manual dispatch | compile, run ETL, inspect output, auto-commit or open PR | 18 |
| `release.yml` | pushes to `main` excluding selected paths | version analysis, validation, archive, release | 20 |

## Findings

### Quality gates are not consistently blocking

The following steps currently use `continue-on-error: true`:

- `deploy.yml`: lint, format, TypeScript, and unit tests;
- `test.yml`: lint, format, and TypeScript;
- `release.yml`: lint, format, and unit tests.

The `test.yml` summary explicitly treats lint/format failures as warnings. This means a workflow can report success while quality checks fail. The reorganization should remove these exceptions once the existing baseline failures are triaged, or split them into explicitly non-blocking advisory jobs whose status is not presented as a passing gate.

### Runtime policy is inconsistent

ETL uses Node 18 while deployment, tests, and release use Node 20. The repository should choose and document one supported Node version, then use it in all workflows and local setup. The current package does not declare an `engines` field or provide `.nvmrc`/`.node-version`.

### ETL workflow behavior needs a future review

`etl.yml` can push generated data directly to `main` when it reports zero errors. That is an operational decision with a larger blast radius than the reorganization itself. Before DuckDB becomes authoritative, the workflow should produce a reviewable artifact or pull request containing the manifest, contract results, and row-level delta report.

The workflow currently watches `data/events.txt` and `data/venues.txt`; the input policy should explicitly include `data/latest.txt`, curation files, and eventually the `data/steve/` fixture harness where appropriate.

### Build commands are not yet layered clearly

The repository has separate commands for `build:etl`, `build`, `build:full`, and `etl`, but workflows use them inconsistently. The final target should name the layers clearly:

1. type-check pipeline code;
2. run data contract/ETL tests;
3. build canonical store and exports;
4. run export contract tests;
5. build browser application;
6. run browser/E2E/performance tests.

### Missing target gates

The reorganization should add or formalize gates for:

- exact manifest byte sizes/checksums;
- all manifest references and foreign keys;
- sequential `data/steve/` ingestion and idempotence;
- DuckDB schema and SQL quality checks;
- DuckDB-to-static-export equivalence;
- privacy request allowlist and no user-action upload;
- cold-cache deep-link and search behavior;
- a browser bundle check that prevents DuckDB from entering the client before approved.

## Recommended CI sequence after the first waves

```text
domain tests
  -> ingestion/normalization tests
  -> incremental fixture contract tests
  -> DuckDB build and SQL checks
  -> static export contract tests
  -> browser build
  -> unit/E2E/performance/privacy tests
```

Each stage should fail the job on a real failure. Artifacts should include the manifest, ETL summary, fixture delta report, DuckDB quality report, and browser test reports.

## Local verification limitation

This worktree does not have the project dependencies installed, and the `bd` executable is unavailable in the current shell. The audit is based on static workflow inspection. A later agent with the supported Node environment should run the commands and convert the documented gaps into validated gates.
