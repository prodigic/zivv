# Local-act review coverage

The bounded pass covered all **526 catalog entries**: 489 research assignments,
three pilot acts and 34 previously verified billing aliases. Final coverage is
**222 review-backed descriptions**, 274 not-found outcomes, 21 inaccessible-source
gaps and nine unresolved identities/configurations. All canonical names and IDs
are preserved. A not-found outcome does not establish that no review exists.

| Research worker | Model and reasoning | Assigned | Found after checkpoint corrections |
| --- | --- | ---: | ---: |
| Batch 1 | GPT-6.1 Sol low | 163 | 62 |
| Batch 2 | GPT-6.1 Sol low | 163 | 59 |
| Batch 3 | GPT-6.1 Sol low | 163 | 69 |

GPT-6 Astra high performed independent checkpoint and final audits. Final samples
contain 55 records, selected with recorded deterministic seeds plus status and
positive-coverage additions. All **21 sampled positive summaries** passed source,
identity and claim checks. The final audits recorded 39 passes and 16 minor
findings, with no blocking factual failures. Those findings include eleven usable
original-review recoveries, missing author credits and several leads that remain
withheld. Earlier checkpoint corrections are retained in their separate reports.
Counts are audit observations, not a claim that every published description was
independently checked by two agents.

All eleven final recoveries were reviewed and integrated. Hollow Minds also
supplied its verified billing alias, making five additional catalog descriptions
from the final batch's four recovered acts. Different-configuration live reviews
remain withheld for solo/acoustic/duo aliases. Review dates, work titles and
publication links are visible in the app; older performance evidence is presented
as historical, without promising the same current set or lineup.

The main efficiency finding is asymmetric: the small pilot favored Sol low for
accurate positive summaries, but its shallow negative searches missed usable
sources. Audit and repair effort must be included when assessing its value.
Future negative passes should follow supplied identity/official press links and
try a locality or release-specific query before finalizing a gap. The remaining
negative rows have not received an exhaustive second search. Batch 2 also required
checkpoint repair after a tool-state persistence error; recovered rows were
verified on disk before use. Actual per-agent tokens, billing and certified
latency are unavailable, so no measured price-performance winner is asserted.

See the [full catalog and per-record gaps](local-act-review-catalog.json),
[model trial](review-model-trial.md), [quality protocol](enrichment-quality-protocol.md),
and final audit reports for [batch 1](local-review-audit-final-1.md),
[batch 2](local-review-audit-final-2.md) and [batch 3](local-review-audit-final-3.md).
The publishable registry is [artist reviews](../../data/artist-reviews.json).
