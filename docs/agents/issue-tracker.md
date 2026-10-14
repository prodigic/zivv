# Issue tracker: Beads

Issues for this repo live in beads: `.beads/issues.jsonl`, tracked in git, managed with the `bd` CLI. Do not create GitHub Issues or `.scratch/` files for tracked work.

## Commands

- `bd ready`: unblocked work
- `bd list --status=open`: open issues
- `bd show <id>`: details and dependencies
- `bd create --title="..." --type=task --priority=2`: new issue (priority 0 to 4)
- `bd update <id> --status=in_progress`: claim work
- `bd close <id> --reason="..."`: finish work
- `bd sync`: commit and push beads changes at session end

Skills that create, triage, or close issues should use these commands. `bd` is not on PATH on this Windows machine; locate it before relying on it.

## Session close

Follow AGENTS.md "Landing the Plane": run `bd sync` before pushing.
