# Newsletter publish lead-time investigation

Investigation only — no activation. Branch `codex/investigate-newsletter-latency`,
cut from `origin/main` at `6ab7457` (v0.94.0). This document records what the
current end-to-end path is, where its wall-clock time goes, and what would have
to change to shorten the time from "the Steve's List newsletter email arrives"
(weekly import cycle starts) to "the Zivv public site shows the new weekly
edition". It activates nothing: no scheduler, no controlled-publication flags,
no email sending, no acquisition change. The manual Friday release path stays
authoritative and untouched.

Evidence sources: the maintained docs (`docs/friday-delivery-plan.md`,
`docs/shared-ledger.md`, `docs/weekly-stage-contracts.md`,
`docs/reviewed-weekly-import.md`, `docs/release-candidate.md`,
`docs/verify-release.md`, `docs/weekly-publication-dispatch.md`,
`docs/verified-weekly-acknowledgement.md`), the per-import journals
(`docs/steve-list-2026-10-02-import.md`, `-10-09-`, `-10-16-`, `-10-23-`),
GitHub issues #38, #39, #42, #43, #6, #9, #192, #174, #15, #63 and issue #133,
plus a read-only walkthrough of `package.json`, the `scripts/*.js` pipeline
commands and the `deploy.yml` / `publish-candidate.yml` / `etl.yml` workflows.
One local (non-ingestion, non-publishing) measurement was taken in a scratch
worktree: `npm run build:etl` compiles in ~4–6 s non-incrementally.

## (a) As-is timeline map — email arrival to public site update

Active publication today is the **legacy route** (controlled publishing flags
`ZIVV_CONTROLLED_PUBLISHING` / `ZIVV_MANUAL_PUBLISHER_JOINED` are unset by
contract): the operator pushes the validated export + encrypted snapshot to
`main`, and `deploy.yml` (mode `legacy`) builds and deploys GitHub Pages. The
journaled candidate/dispatch path (`publication:prepare/retain`,
`pages:dispatch`, `publish-candidate.yml`, runner `--through dispatch|verify|acknowledge`)
is implemented but dormant and flag-gated — it is not part of the measured path.

| # | Stage                                | Command / actor                                                              | Observed or estimated duration | Dominant cost                                 |
|---|--------------------------------------|------------------------------------------------------------------------------|--------------------------------|------------------------------------------------|
| 0 | Newsletter email arrives             | Steve's List, typ. Fri ~4:40–5:40 p.m. Pacific (Oct 2 4:43, Oct 9 5:38, Oct 16 5:40) | —                              | Not observed Oct 23/30; availability of the agent session to mint the Gmail intake snapshot |
| 1 | Intake capture (evidence)            | `weekly:capture-email` (agent/operator)                                      | < 1 min (incl. `build:etl`)    | Local parse/validation only                    |
| 2 | Review (preflight + reconcile)       | `weekly:review-import` (operator/agent, possibly several attempts)           | minutes per attempt; **whole email→export window was 20–47 min**  | Human/agent review round-trips when blocked (`CORE_RECONCILIATION_REQUIRED`, wrapped-row/room/duplicate variants) |
| 3 | Guarded load                         | `weekly:load-reviewed`                                                       | seconds–mins                   | Local SQLite transaction                       |
| 4 | Freeze + export                      | `weekly:prepare`, `ledger:backup`/`ledger:verify`, `etl`                      | ~1–3 min                       | ETL export + verified snapshot; compute fine (rehearsals 17.8 s import / 130.4 s eight stages) |
| 5 | Release commit + push to `main`      | operator/agent                                                               | mins                           | Review of changed files; Oct 23: ≈44 min from export commit to Pages run creation (release commit's production CI in that window) |
| 6 | Pages build & deploy                 | `deploy.yml` (build → deploy-pages; `pages` concurrency group)                | measured **1m42s–2m09s** on clean Fridays (Oct 9/16, Oct 2); **31m26s** on Oct 23 — the single largest observed single-stage anomaly | CI queue + Pages platform |
| 7 | Live verification                    | agent deep-verify (28 route observations Oct 23; 64 + 20×2 Oct 30)            | ~5 min after Pages completion  | Bounded live checks                            |
| 8 | Published-state / acknowledgement    | `mark-published`/state commit → triggers a **second** full Pages cycle         | Oct 23: **46m53s** publish-state commit → live; #133 closed 9m later | Post-publication; does not delay the site showing the new edition |

**Observed totals (arrival → site verified):** Oct 2 ≈ **28 min**; Oct 9 ≈ **50 min** (incl. one restore round-trip); Oct 16 ≈ **25 min**; Oct 23 ≳ **80 min** for arrival→live (arrival unrecorded; freeze 7:07 p.m. → verify 8:27 p.m., plus >2 h to acknowledgment). Typical working estimate: **~25–50 minutes**, with a bad-day tail > 2 h driven by review restores and deploy queue anomalies. The import/review phase, not compute, dominates: every edition since Oct 9 logs at least one blocked-restore re-review cycle.

Serialization: stages 1→4 are strictly serial by contract (journal lease, one
writer). Stage 5→6 is serial per push. Stages 6 and 7 are serialized by
deployment completion. There is deliberate **no internal waiting**: the
Friday-midnight gate (`weekly-publication.ts` `assertWeeklyPublicationTime`)
refuses rather than sleeps, the runner returns `pending` after dispatch with
"the caller must schedule another bounded invocation" (`docs/weekly-publication-dispatch.md`),
and there is no monitor/alerting (#37 still open) — so any miss re-incurs a
human round-trip.

## (b) Top latency contributors, ranked by phase

1. **Review round-trips (import phase, 10–40 min of observed windows)** — blocked reconciliation/normalization on every recent Friday (Oct 9 Gilman mismatch, Oct 16 wrapped-row annotations, Oct 23 room/duplicate variants); each block costs a human/agent inspect-edit-retry cycle. Compute is negligible.
2. **Publish tail variance (5–75 min+)** — clean Fridays: export→live ≈ 4–5 min (Oct 16) with measured Pages runs 1m42–2m09. Oct 23: ≈44 min before the Pages run was even created + 31m26s run + 46m53s second (ack) cycle. The `deploy.yml` job itself carries `npm ci`, lint, format, `tsc -b`, `playwright install --with-deps chromium`, `test:run` (~6 min observed Test Suite), `test:ingestion`, and `vite build` serially before upload.
3. **Human-in-the-loop handoffs** — only an agent session can mint the Gmail intake snapshot (`docs/steve-email-intake.md`); the midnight gate is operator-re-run, dispatch-pending is operator-scheduled; there is no alerting/monitoring (#37) and no automatic acquisition (#30/#29), so every gap re-incurs a manual round-trip (and Oct 20's quota stop dead-stopped a mid-cycle week).
4. **Per-command `build:etl` overhead** — ~30 npm scripts re-run a full non-incremental `tsc` of ~145 files (~4–6 s each, measured), ≈1–3 min per session; plus `RUN_CONTEXT_CHANGED` re-hashing of `dist/` after every guarded boundary.
5. **Post-publication double deploy** — the published-state/acknowledgement commit re-entered the full Pages path (46m53s on Oct 23). Doesn't delay the site showing the new edition, but consumes queue capacity and agent attention during the window when a rollback would matter most.
6. **Deep live verification breadth** — ~5 min mid-size (28 routes) growing to 64 browser + 40 newsletter observations (Oct 30). Safety gate, already 4-way concurrent; not a major lever.

## (c) What would need to change — ranked items

Every item must satisfy the [Friday plan](friday-delivery-plan.md) checkpoint rule: the existing manual path keeps working, with exact tested fallback commands; preview changes must leave Pages publication available; publication gates stay optional until verified.

| Rank | Change | What changes | Prerequisites / checkpoints | Risk | Trial without activation? |
|------|--------|--------------|------------------------------|------|---------------------------|
| 1 | **Pre-seed reconciliation knowledge to prevent review blocks** | Data prep: maintain artist/venue aliases, correction records, venue rename/split crosswalks (#5/#12/#26) ahead of Friday; wrap-row/programming-row policies documented and pre-audited. Also make the review loop one bounded session (run `review` retries against persisted attempt artifacts without standing down). | Manual path unchanged (aliases/corrections already supported by the same ledger); verify with a representative edition on an isolated store; keep fallback commands current. | Low — reduces *ambiguity* upstream, touches no orchestration; worst case a Friday still blocks and falls back. | **Yes** — pure data/metadata + operator procedure |
| 2 | **Split `deploy.yml` fast-path for data-only pushes** | Workflow edit: when a push to `main` touches only `public/data/**` + `data/ingestion/backups/**` (+ weekly state), skip app lint/format/tsc/`test:run`/Playwright install and run `test:ingestion` + `vite build` + deploy; path-filter the published-state/ack commit so it does not trigger a second full deploy. | #39 owns "approved narrow workflow edits"; keep `pages` concurrency; the full gate stays mandatory for any content commit (paths filter is content-keyed, not author-keyed); rehearse a rollback to the full workflow. | Medium — a filter bug can skip required verification; the release gates must not get weaker for any commit that includes code. | Half — the second-deploy suppression and cache/Playwright trimming can be rehearsed via workflow_dispatch on a branch without activation; merging the change to `main` is a normal trusted-automation checkpoint, not a publishing-flags activation. |
| 3 | **Cache CI tooling and make `build:etl` incremental** | `tsconfig.build.json`: add `incremental`/`tsBuildInfoFile`; Actions: cache Playwright browsers / node pkg cache already present. Locally, `npm ci` can be batched once per session instead of per-command (no script re-installs today, so this is session hygiene, not CI). | None beyond tests; `RUN_CONTEXT_CHANGED` hashes `dist/`, which incremental output leaves byte-identical — verify with the focused runtime/migration tests. | Low | **Yes** |
| 4 | **Trim the publish tail during Oct 23-style congestion** | Measure and, if the trigger is adoptable, stagger/prioritize the release deploy (run release push when queue empty; avoid pushing unrelated commits during the release window), and pre-verify the release commit's CI on a branch before the release push so the full job isn't discovering failures fresh. | Operator procedure first (no workflow change), then optionally the item 2 path filter to reduce double-loading. | Low | **Yes** (procedure) |
| 5 | **Static, activation-gated: combine dispatch→verify→acknowledge invocations** | The dormant journaled path already removes the push-to-main round trip and the double deploy (single verified candidate, one deployment, native verify + acknowledge). But it requires #38/#43 acceptance: legacy publisher joins durable promotion control (`publisher-mode-transition.md`), preview/live/rollback rehearsals, and two observed Fridays. | #38, #43 + `ZIVV_CONTROLLED_PUBLISHING=enabled` + `ZIVV_MANUAL_PUBLISHER_JOINED=true` | High — this is the approved activation gate; Changing it out-of-band would brick the Friday contract. | **No** — activation-gated |
| 6 | **Structural (largest absolute reduction, largest cost): automatic acquisition + scheduler + monitoring (#30, #29, #37)** | Removes the agent-session Gmail capture dependency and the operator-scheduled re-invocations; adds missing-heartbeat/missing-run alerting. | #38 stage 5/6 + runtime/credentials/budget decisions; two observed scheduled Fridays. | High | **No** — activation-gated |

Not recommended: trimming live-verification breadth (item 4 safety gate, #36),
relaxing the Pacific-midnight/Friday window (approved contract, week-to-week
safety, not lead time in practice since arrival is typically ~5 p.m., 7 h
before midnight) or adding circumvention around half-open windows / pending-batch
settlement (#42 — these guard correctness, not latency).

## (d) Most lead time per engineering day

1. **Item 1 (reconciliation pre-seeding)** — the only ticket that attacks the largest observed block (every Friday since Oct 9 had ≥1 review restore). Small working sessions; can shave **~10–30 min** of typical lead time and kills the worst-case import tail.
2. **Item 2 (deploy workflow fast-path + second-deploy suppression)** — bounded one-workflow PR per #39, average ~5–15 min saved tail; can cap worst-case tails (the 31–47 min queue anomalies) by removing two full CI/deploy circuits from the release day's traffic.
3. **Item 3 (incremental `build:etl`)** — ~1–3 min per session, minutes of work.

Items 5–6 are the true shortening from ~30–60 min to minutes — but they are
exactly the activation plan already agreed (#38 stage 5/6) and are gated behind
rehearsals, not code to write today.

## (e) Bottom-line recommendation

- **Current lead time: ~25–50 min typical (email → site), with a worst observed day over 2 h (Oct 23 import tail and queue congestion; >2h20m to acknowledgment).** The pipeline's own compute is small; the wall clock is dominated by human/agent review round-trips and by GitHub-side CI/deploy/left-tail behavior.
- Best per-day investments now, all within the checkpoint contract and none
  activating anything: (1) pre-audited reconciliation data + a bounded single-session review loop, (2) a #39-reviewed narrow `deploy.yml` edit to fast-path data-only pushes and suppress the redundant published-state deploy, (3) incremental TypeScript compile caching.
- **Realistic estimated shave from the top levers: roughly one-half of the typical path — ~25–30 min off a usual ~35-min window (to ~10–20 min), and removal of the >1-hour anomalous tails.** Going below ~10 minutes requires the activation-gated structural work (#30/#29/#37 scheduler + automatic acquisition, and optionally the dormant controlled publisher) rather than further optimization of the manual path.

## References

- Approved delivery contract: [friday-delivery-plan.md](friday-delivery-plan.md) (#38)
- Stage contracts: [weekly-stage-contracts.md](weekly-stage-contracts.md) (#42)
- Reviewed import load/review: [reviewed-weekly-import.md](reviewed-weekly-import.md)
- Candidate/verify chain: [release-candidate.md](release-candidate.md), [verify-release.md](verify-release.md)
- Controller publication (dormant): [weekly-publication-dispatch.md](weekly-publication-dispatch.md)
- Friday journals with observed times: [steve-list-2026-10-02-import.md](steve-list-2026-10-02-import.md), [-10-09-](steve-list-2026-10-09-import.md), [-10-16-](steve-list-2026-10-16-import.md), [-10-23-](steve-list-2026-10-23-import.md), issue #133/#174
- Gate workflow concerns: #39, #43, #6/#200, #9/#192, #37 (monitoring)
