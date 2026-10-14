# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `prodigic/zivv`. Use the `gh` CLI for all operations.

Beads (`bd`) is retired. Its history stays in `.beads/issues.jsonl` for reference only; do not use it for new work.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..." --label needs-triage`. Use `--body-file` for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --label ready-for-agent`.
- **Make an issue a sub-issue of a parent**: `gh issue edit <parent> --add-sub-issue <child>` (`gh` 2.94+). Without sub-issues, put `Part of #<parent>` on the first line of the child body.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Claim**: `gh issue edit <number> --add-assignee @me`.
- **Close**: `gh issue close <number> --comment "..."`.

Infer the repo from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Priority

GitHub has no priority field. Put `Priority: P0` through `Priority: P4` on the first line of the body.

## Migrated from beads

The October follow-ups from beads were migrated on 2026-10-13:

| Beads ID | GitHub |
| --- | --- |
| `zivv-sf-artwork-gaps` | #17 |
| `zivv-local-act-link-gaps` | #18 |
| `zivv-local-review-gaps` | #19 |
| `zivv-unlocated-venue-maps` | #20 |
| `zivv-venue-address-evidence` | comment on #5 |

The January phase items in beads were not migrated; they are obsolete.
