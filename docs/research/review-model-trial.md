# Review research model trial

Three identical bounded assignments covered Modern Monsters, Sour Widows and
Swingin Utters. Each worker could use eight search queries and eight page opens.
GPT-6 Astra high audited the nine records without producer model labels.

| Output | Worker | Pass | Minor fix | Fail | Worker-reported queries / opens |
| --- | --- | ---: | ---: | ---: | ---: |
| A | GPT-6 Luna medium | 1 | 1 | 1 | 3 / 4 |
| B | GPT-6.1 Sol low | 3 | 0 | 0 | 3 / 4 |
| C | GPT-6.1 Sol medium | 2 | 1 | 0 | 5 / 8 |

Sol low is the provisional default for independent review research. It met the
requested coverage with no required content repairs in this pilot. This is a
quality selection, not a demonstrated token-cost ranking: per-worker tokens and
billing are not exposed. Worker timestamps and tool counts are self-reported,
not independently certified performance telemetry. The sample is too small to
establish a general model ranking, especially for different work such as parsing
venue calendars.

The audit caught unsupported hooks/live-set wording in A's Modern Monsters
summary and an uncited identity source in A's Swingin Utters record. C's additional
Post-Trash source needs qualification because its critic later had a label
relationship with Sour Widows; the relationship at the time of the 2020 review
was not established. All seven distinct review pages opened successfully. See
[the full audit](review-pilot-audit.md) for exact findings and evidence.

The initial accepted application records use C's audited, newer Modern Monsters
reviews and B's Sour Widows and Swingin Utters records, normalized to canonical
catalog IDs and names. A remains unaccepted; its raw result is retained for the
comparison. No artist is described as having a current live sound solely from an
old release review. Reviewed work and publication date remain visible in the UI.

Audit overhead is part of the comparison: Astra reported seven web invocations,
three search entries and 24 open/click entries across 15 distinct URLs. The extra
work checked source ownership and date ambiguity as well as the prose. Future
batches use the [sampling and escalation protocol](enrichment-quality-protocol.md)
to keep that overhead bounded while checking ongoing quality. Failed or corrected
records are counted as rework, not silently scored as initial successes.

Raw outputs: [A](review-pilot-a.json), [B](review-pilot-b.json),
[C](review-pilot-c.json), [audit decisions](review-pilot-audit.json).

## Full-catalog follow-through

Sol low completed three 163-act batches. Checkpoint-corrected positive counts were
62, 59 and 69. Astra high's three final samples checked 55 records: all 21 existing
positive summaries were supported, while negative checks recovered eleven usable
original reviews. Missing author credits were also corrected. Thus the initial
pilot result holds for sampled positive precision, but shallow negative recall
adds meaningful auditing and repair work. Follow identity anchors and official
press referrals before finalizing negative outcomes; keep the published coverage
and its limits explicit. See [final coverage](local-act-review-summary.md).
