# San Francisco show artwork

Checked 2026-10-10. Reviewed 223 SF venue records; 48 had 657 listed shows. Accepted **421 artwork links across 29 venues**. The remaining 236 shows have unresolved or conflicting evidence; this is not a claim that artwork does not exist. The inventory includes recently elapsed shows retained in the event history.

## Sources and validation

Official calendar cards, observed ticket links, event-page dates and embedded public DICE/Turntable Tickets listings establish each association. HTTPS image responses were validated using MIME type or image signatures. Some SeeTickets WEBP images have an incorrect HTTP Content-Type; actual bytes confirm the image format. 42 images are labelled posters and 379 conservatively labelled event artwork. No venue logos or generic substitute images were applied.

GPT-6 Luna medium produced batch1 and GPT-6.1 Sol low produced batches2–3. Root recovered the dynamic Kilowatt and Black Cat sources. These were different inventories, so raw match counts do not establish a fair model-cost comparison.

GPT-6 Astra high audited 78 positive samples and 14 negative samples, with 75 positive passes and three corrections/withholds. It recovered seven omitted candidates. Parent accepted the exact date, venue and support-lineup bridge for Imaad/Imadd Wasif while retaining the canonical spelling; the Black Cat residency explicitly lists Friday October9 within its three-night run. Parent also matched Paul Collins Night2 using the independently audited DICE method. All 421 final records pass exact canonical identity validation; no stale IDs.

Two Knights of Molino records remain withheld because the venue page and flyer disagree between 435 and 443 Broadway. The Carol Luckenbach image URL was refreshed to the observed current version. DragonForce at Black Cat has an official UC Theatre venue conflict and remains unmodified. Other gaps include access blocks, dynamic/visual calendars, aliases and missing original listings. See the per-venue worker reports and [complete coverage](sf-event-poster-coverage.json); those initial reports are superseded by this consolidated result.

Full decisions: [independent audit](sf-event-posters-audit.md), [audit data](sf-poster-audit-results.json). Registry: [event posters](../../data/event-posters.json).
