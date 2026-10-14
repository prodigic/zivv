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
