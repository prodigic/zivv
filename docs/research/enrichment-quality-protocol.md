# Enrichment quality and agent efficiency

The user requested model trials on divisible work and periodic stronger-model
sample audits on 2026-10-10. This protocol applies to the local-act reviews and
SF show-poster research in this worktree.

## Pilot

Give three workers identical inputs and acceptance criteria: GPT-6 Luna medium,
GPT-6.1 Sol low, and GPT-6.1 Sol medium. Use Modern Monsters (78581369), Sour
Widows (36869837), and Swingin Utters (708820545) to cover differing levels of
press coverage. Keep source-search limits equal. Compare correct, useful records
accepted after audit, elapsed time, tool calls and measured tokens when exposed.
Do not substitute elapsed time or output length for token use, or invent dollar
costs. A three-act pilot is provisional evidence, not a universal model ranking.

## Independent checks

Use GPT-6 Astra high for the pilot audit and periodic production-batch audits.
Hide producer model labels from the reviewer. The reviewer opens source pages
independently and checks the actual claims, rather than trusting the worker's
confidence or citation formatting. The parent resolves disagreements against
the source evidence. A stronger model is a reviewer, not ground truth.

Audit the entire pilot, then a deterministic 10% random sample of each completed
batch (minimum 3 records, or all records for smaller batches), plus every flagged
ambiguous identity, conflicting source, and unusually strong claim. Include some
negative results to detect avoidable omissions. Record the selection seed, IDs,
findings and corrections. Repeat after a model, prompt or source-adapter change.
These are work-batch checks, not a scheduled background automation.

Any wrong identity, wrong show/date, fabricated citation or unsupported factual
claim blocks the affected batch. Expand inspection to the whole affected source
or matching method; rework failed records and re-audit corrections. If the cause
is uncertain or recurs, audit the entire batch and increase worker capability.
Track auditing and rework alongside initial research when comparing efficiency.

## Acceptance criteria

- Correct canonical artist or exact venue/date/performer identity.
- Direct, opened source URLs and recorded research date.
- Reviews come from original reviewers; promotional biographies are not reviews.
- Distinguish live reviews from release reviews. A release-based vibe describes
  the recorded sound and does not promise current concert behavior.
- Short original summaries supported by cited evidence; no invented firsthand
  attendance, listening, scores, publication dates or consensus.
- Artwork must be observed on an official show listing. Label promotional photos
  as event artwork, not a flyer; never use a venue logo as a show poster.
- Missing, inaccessible and ambiguous evidence remain explicit gaps. Reuse
  canonical research for verified aliases, preserving the alias relationship.

The method follows [OpenAI's evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices): use task-specific criteria, representative inputs and continuing evaluation. Local source checks and human corrections remain authoritative.
