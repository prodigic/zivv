# Steve List October 9, 2026 import

The confirmed October 9 edition arrived at 5:38 p.m. Pacific. Its exact email
text, prepared input, import receipt, source audit and merged legacy archives
remain in ignored operator files. The authoritative catalog is the shared
SQLite ledger outside worktrees; its authenticated encrypted snapshot is
published alongside the public export.

## Source accounting and corrections

All 1,174 source date headers are accounted for. Seven programming-only rows
are explicitly excluded using the existing non-performer list: three Gilman
membership meetings, Cholos Vs. Vampires, two Emo Night rows and a volunteer orientation. The remaining 1,167
rows reconcile to 1,166 unique accepted observations, including a repeated
Cheekface listing with alternate support billing. No unresolved matches remain.

Reviewed source corrections restore the November 5 Stork Club venue separator
and the November 13 Other Lives weekday token. Shed A's location now parses
as San Francisco instead of Pier 48. Gilman Brewing Company and Feinstein's
resolve to their existing venues, confirmed by matching source addresses.
Music Hall in Felton resolves within Felton instead of using the generic Napa
alias. Undergarden retains its San Francisco city label. Misspelled volunteer
orientation and Emo Night labels are normalized before audited exclusion.
The Gilman October 11 bill's explicit noon time is represented as 12pm, and
its revised time is recorded with provenance on the existing event identity
before reconciliation. The final conjunction retains the Hemmed Up artist ID.

The first unpublished attempt exposed the Gilman venue/time mismatch during
review. An authenticated pre-import checkpoint was restored with an exact
shared-revision guard; the corrected batch was then imported. No faulty export
was published. The private legacy archive's year stamping was checked separately
against the source issue date; public ETL reads the authoritative ledger.

## Result and validation

The catalog contains 4,641 events, 8,678 artists and 656 venues: 146 additions
and 46 source-updated events. All 4,495 prior event IDs, slugs and first-added
dates survive. The October 9 draft freezes all 146 additions since the last
successfully published cutoff, including any daily imports in that interval.
Its fixed cutoff is `2026-10-10T01:24:28.423Z`.

All 22 manifest-listed files pass byte-size and SHA-256 checks. There are no
new events dated before this edition or new same-date/venue/headliner duplicates.
Geographer remains local, and the reviewed Rio Theater city remains Santa Cruz.
Existing venue addresses and websites are retained. Encrypted recovery
verification reconstructs the complete catalog and validates database integrity.

The 220 ingestion/component tests, application and tooling TypeScript checks,
lint, locked formatting check and production build pass. Dependencies were
installed from the package lock after the previous shared installation lost
its Node fetch typings.

Existing follow-ups remain in issues #5 and #12 for ambiguous venue identities,
#10 for reusable source preparation, and #9 for broader legacy test discovery.
Two previously existing same-date bill groups remain; this import adds none.
Publication is tracked in [issue #15](https://github.com/prodigic/zivv/issues/15).
The weekly edition is marked published only after deployment and live checks.
