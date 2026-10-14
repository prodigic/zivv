# Three-act link pilot: medium trial

Checked on 2026-10-10. This independent bounded trial researched Modern Monsters (78581369), Sour Widows (36869837), and Swingin Utters (708820545). Output is `.cache/act-link-pilot-medium.json`. No application, data, public export, or Git files were changed.

## Result

All three rows are `links-found`, with five accepted links: two websites, two Bandcamp profiles, and one Apple Music profile. No social profiles were accepted. `links-found` means at least one supported link, not complete platform coverage. The Swingin Utters Bandcamp identity was reused from the supplied verified catalog; its current accessibility was not confirmed. The Apple Music identity was independently corroborated by a current first-party search excerpt.

| Act | Accepted links | Principal remaining gaps |
| --- | --- | --- |
| Modern Monsters | Official website | Exact Facebook and SoundCloud destinations; other platforms |
| Sour Widows | Bandcamp, official website | Exact Instagram, Twitter and Spotify destinations; other platforms |
| Swingin Utters | Previously verified Bandcamp, Apple Music | Website accessibility, social profiles, canonical Spotify profile |

## Provenance and method

Read `.cache/link-research-photo-catalog.json`, `.cache/all-local-image-inventory.json`, and `docs/research/local-act-review-catalog.json` for these exact IDs. Existing Bay Area identity evidence and release names anchored the pass. Reused prior verified identity sources where allowed. Did not inspect the independent low-trial output.

- [Modern Monsters homepage](https://modernmonstersmusic.com/) names the band and the October 16 Up the Creek Records show, matching the inventory. Followed its [official EPK](https://modernmonstersmusic.com/epk) as the permitted additional hub.
- [Sour Widows Bandcamp](https://sourwidows.bandcamp.com/) identifies the California/Bay Area band and its releases. Followed its direct website link to [Sour Widows](https://www.sourwidows.com/).
- [Swingin Utters Bandcamp](https://swinginutters.bandcamp.com/music) was already verified in the supplied photo catalog; the new web retrieval returned cache miss. The supplied [Apple Music identity anchor](https://music.apple.com/us/artist/the-swingin-utters/205749870) was corroborated by a first-party search excerpt identifying the band and its established history. An observed legacy website URL resolved to HTTPS during retrieval but timed out, so no website was accepted.

Only observed HTTPS URLs were accepted. No handles, profile IDs or destination paths were guessed. Recording pages, player embeds, search/share URLs, unrelated label links and platform posts were excluded. The web renderer exposed named outbound platform links without their exact hrefs; recovering them would require further retrieval, so they remain documented gaps.

## Tool counts and trial limitations

Four web-tool calls contained three search queries, six explicit page opens/clicks, and three find operations against already opened pages. The six opens/clicks yielded four successful pages and two retrieval failures. Modern Monsters and Sour Widows each used one identity page and one additional official hub; Swingin Utters used one failed identity-page refresh and one failed official-hub attempt.

Additionally, one shell call attempted three HTTP retrievals: Modern Monsters EPK, Sour Widows Bandcamp, and Swingin Utters Bandcamp. All returned DNS errors without source content. These are sandbox transport failures, not evidence that the sites or profiles are absent. The later instruction that public HTTP requires escalation arrived after the six explicit web-open ceiling had been reached, so no further network attempts were made. Thus the pilot met the three-query/six-web-open bound but had nine total HTTP retrieval attempts if failed shell transports are included. This overhead should remain visible in the trial comparison.

This pass is a conservative partial collection with tool rework, not a complete link enrichment. Token usage and monetary cost were unavailable; neither is estimated. The parent orchestrator should record actual configured model and reasoning level from its dispatch metadata rather than infer them from this filename.
