# Local act links research

Checked on 2026-10-10. The collector checkpoints below are historical; the final
audited integration contains 725 URLs across 298 of 526 records. There are 224
bounded research gaps and four unresolved act identities. See
[final audit](local-act-links-audit.md), [full catalog](local-act-links-catalog.json)
and [export verification](artist-link-export-validation.json).

GPT-6.1 Sol high completed the frozen handoff from saved evidence after the user
requested replacing Astra to conserve tokens. It made no new network requests.
The public UI presents one destination per platform, preferring an observed
artist profile over a release; the research retains all verified URLs.

All 526 exact catalog ID/name records are present. Initial source-anchor reuse yields 331 links across 297 records, with 34 verified aliases. 397 distinct outbound URL/source candidates are recorded separately and have not been accepted. Unknown site ownership, unknown platform URLs, inaccessible sources and composite identities remain explicit gaps.

The collector made 349 cumulative unique HTTP source-page requests: 3 pilot, 303 initial full pass, 41 inventory expansion and 2 changed source-selection requests. Of these, 337 returned HTTP 200 and 12 returned other statuses or failed. The audit-input rebuild used cached pages and no new requests. Collector search queries: zero. Independent pilot/auditor requests are separate. No token or monetary cost measurement was exposed.

## Blocking method failures and complete rework

An early extraction incorrectly treated a photo's subject identity as proof that its source was artist-owned, admitting publisher/presenter accounts. Source ownership also does not make every outbound destination attributable: vendor accounts, other bands and member projects appeared in outbound candidates. Both were blocking failures, not accepted enrichment.

All 173 custom-website candidate records were reviewed, producing 189 URL-specific ownership decisions: 96 artist-owned, 14 ownership-unresolved and 79 third-party-identity-only. Exact artistId/domain approvals, cached title and description, prior evidence and ownership rationale are in `.cache/act-link-ownership-decisions.json`. No name/domain substring heuristic remains. Publisher, agency, venue, label, association and news pages remain identity evidence only. Unresolved pages remain ownership gaps, not evidence of absence.

All outbound-derived destinations now remain unaccepted in `.cache/act-link-outbound-candidates.json`, with exact URL, source URL, artist ID/name, source type and nearby anchor context. The independent stronger-model auditor owns whole-destination adjudication following the failed method. Generic Linktree marketing contamination prompted disabling the entire Linktree outbound extractor. Previously identity-supported exact Linktree anchors may remain.

Initial platform anchors are separate from outbound candidates. Label-account Bandcamp root/catalog URLs are withheld, including Rocks In Your Head and Cherub Dream. Artist-attributed album/track URLs may remain when that exact release URL is the observed identity anchor. HTTP 200 is never identity proof. Prior identity and current access are recorded separately.

## Pilot and handoff

The initial three collector requests covered Modern Monsters, Sour Widows and Swingin Utters. Modern Monsters official homepage directly exposes SoundCloud; Sour Widows artist metadata exposes Instagram, Twitter and Spotify, while the independent pilot observed the HTTPS website redirect; Swingin Utters has verified Bandcamp and the assigned Apple Music anchor. These outbound discoveries remain auditable candidates rather than automatically accepted destination ownership.

No guessed handles, search pages, share intents, individual social posts, venue/ticket profiles or unsafe URLs. Safe observed HTTPS destinations only. Final integration belongs to the parent after source and destination audit. The current `.cache/act-link-results.json` is an initial-anchor checkpoint and will need the auditor's accepted destination map merged. `.cache/act-link-stats.json` holds exact counts. No application, data/public export or git mutation was made by this collector.
