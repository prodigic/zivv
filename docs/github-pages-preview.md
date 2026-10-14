# GitHub Pages preview

The operator approved the public `prodigic/zivv-test` repository on October 14, 2026. It is a compiled-artifact preview, while `prodigic/zivv` remains the source,
issue and pull request repository. This supersedes the earlier GitLab choice in
the Friday delivery plan. Production remains at `/zivv/` until a separately
verified promotion.

## Build paths

`ZIVV_BASE_PATH` selects a same-origin directory prefix ending in `/`. The build
shares it between assets, router, data requests, web manifest and Pages fallback.
Production defaults to `/zivv/`; development defaults to `/`. Preview uses
`/zivv-test/`. Future root-domain hosting can use `/` without a source change.
Preview and production use separate browser cache namespaces.

PowerShell preview build from an already validated public dataset:

```powershell
$env:ZIVV_BASE_PATH = '/zivv-test/'
npm run build:full -- --outDir .cache/github-preview
Remove-Item Env:ZIVV_BASE_PATH
```

The maintained manual Friday import and ETL commands remain unchanged. A preview
build does not import a source, advance an edition cutoff or prove backup/export
agreement. The release orchestrator must validate those contracts before an
unattended candidate is eligible for publication.

## Publication boundary

Only the compiled site and already-public dataset belong in the preview
repository. Do not copy raw email, private reports, ledger databases, journals,
keys, recovery snapshots, operator configuration or worktree files. Do not copy
a production `CNAME` into preview. Use a dedicated `gh-pages` branch and `.nojekyll`
for compiled assets. Record the source commit and artifact checksums with each
candidate, then verify the published bytes and representative deep links.

GitHub Pages configuration uses the repository's publishing branch at its root.
The [official Pages API](https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site)
documents the source branch/path and required administration/Pages permissions.
Candidate publication, live verification and recovery remain tracked by #35,
#36 and #43; creating the repository alone does not complete those issues.

## Observed preview checkpoint

October 14, 2026:

- [Live preview](https://www.prodigic.com/zivv-test/) inherits the account's existing
  custom domain; no preview `CNAME` was added. GitHub reports branch `gh-pages`,
  root publishing directory and build status `built`.
- Source commit `2b19e7ac7b02e981faf41fa00ce8cff588711406` is reviewed in
  [stacked PR #49](https://github.com/prodigic/zivv/pull/49). Preview artifact
  commit is `66f03ba5f110b71c02e6d55284325a88d3cd11d4`.
- Public `preview-build.json` records source commit, base path, dataset version
  and SHA256/size for each compiled file. Live verification at
  `2026-10-14T17:27:56.110Z` matched all 55 files exactly. The public data manifest
  matched SHA256 `b14d0c1700eab7c8d89d6d5f383241029bae358e725298f0c61867910f1b8d5a`;
  all 22 manifest-listed dataset chunks passed local checksum/size verification.
- Live direct navigation to the Strawberry Fuzz event and a returning-browser
  reload rendered the show, venue map, price/time and `/zivv-test/` artist links.
- 404 ingestion/component tests passed across 45 suites; one POSIX-only test was
  skipped on Windows. TypeScript, ESLint, formatting and production/root/preview
  builds passed. GPT-6.1 Sol high audit identified a CLI `--base` mismatch; the
  resolved-config fix passed an actual override build.

This is a hosting and routing checkpoint using the existing public dataset.
It does not establish unattended candidate/ledger/snapshot agreement, rollover,
rollback, full private recovery or two successful scheduled Friday editions.
