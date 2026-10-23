# Venue poster alignment review

The venue directory and venue details now reserve a fixed 36 × 44 artwork column whenever any visible show has valid artwork. Missing artwork no longer collapses a row or shifts dates and artist names left. Venues without artwork keep their compact layout. Poster links remain separate from internal show links.

## Reviewed missing artwork

Checked October 22, 2026 against https://gamh.com/calendar/ and its linked official ticket pages:

- Automelodi, October 22, GAMH: same festival bill as A Split Second / Crash Course in Science. Poster visibly lists Automelodi and the exact date/venue; registry bound to existing event 1611382547.
- dj TR/ST, October 23, GAMH: TR/ST (DJ set) / Buzz Kull bill. Poster visibly lists the exact date/venue; registry bound to existing event 433098467.

Both image requests returned HTTP 200 and valid WEBP bytes. The host incorrectly labels them application/x-www-form-urlencoded; validation used image signatures and visual inspection rather than trusting that header.

Julia Wolf is not an unverified poster fallback: GAMH explicitly lists the October 23 show as moved to the Warfield. The existing Warfield artwork must not be attached to a GAMH identity. Separate correction tracked in https://github.com/prodigic/zivv/issues/128, alongside the officially postponed Ali Amran date.

## Publication boundary

This consolidated release preserves the reviewed public export from PR #118 and the venue-detail alignment from PR #129. Each poster appears once in the registry. No private ledger revision or publication cutoff is changed. The Julia Wolf correction remains separate and requires normal provenance-preserving reconciliation.
