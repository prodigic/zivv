# Local-act reviews: batch 3

Checked 2026-10-10. All 163 assigned artist IDs and exact input names are represented in `.cache/local-review-results-3.json`.

| Outcome | Acts |
| --- | ---: |
| review-found | 69 |
| not-found | 85 |
| blocked | 8 |
| identity-uncertain | 1 |

Each act received a focused search; candidate criticism was opened before a summary was written. Additional searches or opens addressed access or identity gaps. Summaries describe the specific reviewed recording or performance, not a forecast of the currently advertised concert. Negative outcomes are bounded-search findings, not proof that no review exists. Dates and bylines remain null where not established in the accessible evidence.

Artist pages, concert listings, publicity, interviews without musical criticism and namesake artists were excluded. Several reviews are older, retrospective, or cover a different ensemble configuration; those boundaries are retained in each row. Emily Afton has a short KQED listening recommendation; Slumped has substantive criticism within an interview feature. Gabe Bondoc and The Seagulls have personal eyewitness accounts, with their fan or social relationship limitations recorded. Starzdust has a single review. The joint Melvin Seals/JGB/Grahame Lesh billing remains identity-uncertain rather than merging distinct configurations.

Blocked candidates were Cold Water Law Firm, Light Fantastic, Look Away, No Captains, Peach Tree Rascals, Sam Reider, Tainted Love and The Famous. These retain null summaries because the original criticism could not be accessed. For Super Apes, the unofficial magazine PDF led to the opened original Maximum Rocknroll publication; the original publisher URL is retained.

Output checkpoints were explicitly persisted and on-disk counts verified at 20, 40, 61, 82, 101, 121, 141, 161 and 163 rows. Final checks found 163 unique numeric IDs, exact name matches, no missing assignments, and all 69 summaries within 25–45 whitespace-delimited words. Actual token usage and price were not exposed; no cost claim is made.
