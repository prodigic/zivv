# Publisher mode and transition runbook

Checkpoint for [#35](https://github.com/prodigic/zivv/issues/35) and
[#39](https://github.com/prodigic/zivv/issues/39). The legacy main-push workflow
now selects a publication mode before building, configuring Pages, uploading or
deploying. This change does not enable controlled publishing.

| Repository `ZIVV_CONTROLLED_PUBLISHING` | Repository `ZIVV_MANUAL_PUBLISHER_JOINED` | Legacy workflow behavior                                       |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Unset or `disabled`                     | Unset or `false`                          | Existing build/upload and main-push deployment.                |
| `enabled`                               | `true`                                    | Gate succeeds in controlled mode; all legacy effect jobs skip. |
| Any other pair                          |                                           | Gate fails visibly; all legacy effect jobs skip.               |

Values are exact and case-sensitive. Unknown values, trailing spaces and partial
activation cannot accidentally select the legacy publisher. The mode gate has
read-only repository permission and executes no checkout or Pages action. Build
and deployment require a successful gate with its explicit `legacy` output;
deployment additionally requires a successful build and a main push.
The legacy build also runs the full maintained ingestion/publication suite before
building or uploading; a separate CI result cannot be bypassed by this workflow.

The controlled workflow still requires both activation flags and native
controller admission. In controlled mode, manual operators use the
[weekly publication CLI](weekly-publication-dispatch.md), just as the eventual
scheduled runner will. A pending result resumes the same run and private intents.

## Queue isolation

The legacy workflow keeps its build/deployment order under `legacy-pages-build`.
Only its admitted deployment job uses the production `pages` concurrency group,
shared with the controlled publisher. A controlled-mode or invalid-mode legacy
run therefore never reserves that production group.

GitHub's default concurrency queue can replace an existing pending run even when
running jobs are not cancelled. Moving only the deployment job into the production
group prevents blocked legacy runs from replacing a queued controlled publisher.
See [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
and [job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions).
Native ownership remains the authority for controlled effects; queue order is not
publication authorization.

## Before eventual activation

Perform these requirements after the code is merged and rehearsals are accepted.
They are not performed by this implementation checkpoint.

1. Verify reviewed `main` contains the mode gate and controlled publication tools.
   Pin the operator runtime and reviewed workflow commit. Complete preview,
   exact-live verification, public rollback and private restoration rehearsals.
2. Inventory all callers that can create a Pages deployment, including external
   tokens, direct API calls, environment permissions and Pages settings. Repository
   workflow inspection identifies `deploy.yml` and `publish-candidate.yml` as the
   two direct publishers. ETL and release workflows may push main but do not
   directly create a Pages deployment.
3. Drain or explicitly cancel every older nonterminal legacy/controlled run,
   including queued, pending, requested, running and environment-waiting jobs.
   Reconcile any created deployment and native owner. A configuration change does
   not revoke an already queued workflow or a mode decision recorded by a running
   gate. Do not enable controlled publication while one can still deploy.
4. Keep activation flags repository-scoped and remove conflicting environment
   overrides. Verify the replacement manual command, operator recovery material,
   monitoring and notification setup. Only after this evidence is accepted set
   repository and operator runtime flags to `enabled` / `true`.
5. Observe a successful controlled candidate, its exact live receipt and cutoff
   acknowledgement. Confirm a subsequent main push skips legacy Pages effects.
   Two observed Friday editions remain the final acceptance requirement.

This read-only PowerShell inventory paginates each nonterminal state. An empty
output does not replace checking direct deployments, external callers or native
ownership:

```powershell
$workflowNames = @('deploy.yml', 'publish-candidate.yml')
$runStates = @('queued', 'pending', 'requested', 'in_progress', 'waiting')
foreach ($workflowName in $workflowNames) {
  foreach ($runState in $runStates) {
    gh api --paginate "repos/prodigic/zivv/actions/workflows/$workflowName/runs?status=$runState&per_page=100" --jq '.workflow_runs[] | {id, status, head_sha, html_url}'
  }
}
```

## Returning to the legacy path

First stop new controlled dispatch, drain/reconcile its pending runs and any
created deployment, and resolve the native owner. Preserve private catalog,
source history and cutoff evidence. Reverting flags without this reconciliation
can allow an older controlled run to publish after a manual deployment.

After a deliberate transition, use unset/`disabled` and unset/`false` to restore
the maintained legacy import/export/main-push procedure. Never treat a public
rollback as permission to rewind the private ledger. Follow
[shared ledger publication](shared-ledger.md#back-up-and-publish) and retain exact
receipts for the chosen release.

## Implementation evidence and remaining work

The regression fixture first failed against the original workflow. It executes
the actual gate shell over 56 flag pairs, checks the resulting job conditions,
and asserts isolation of the production concurrency group. Semantic workflow
validation separately checks the GitHub Actions definitions. This is local/CI
evidence, not a live mode-transition rehearsal.

The repository gate supplies one part of manual-publisher integration. Setting
`ZIVV_MANUAL_PUBLISHER_JOINED=true` still requires the operational inventory,
drained runs, replacement command and rehearsal evidence above. Source intake,
runtime/scheduling, private recovery, notifications and the remaining acceptance
work remain in the [Friday plan](friday-delivery-plan.md).
