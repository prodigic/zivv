# Local act links audit

Checked on 2026-10-10. Final handoff used GPT-6.1 Sol at high reasoning, replacing the interrupted Astra auditor and reusing its cached decisions and independent page evidence. The finalizer made no new network requests.

## Frozen research result

The frozen research input is `.cache/act-link-audit.json`, with a machine-readable summary in `.cache/act-link-audit-summary.json`.

Durable decision evidence is recorded in [source ownership decisions](local-act-link-source-ownership.json) and [outbound candidate decisions](local-act-link-outbound-decisions.json). The integrated catalog and research report are separate artifacts; the research freeze does not itself confirm publication.

| Measure | Count |
| --- | ---: |
| Inventory records | 526 |
| Records with accepted links | 298 |
| Accepted link entries, including verified aliases | 727 |
| Records without a found link | 224 |
| Identity-uncertain records, with links withheld | 4 |
| Eligible aliases propagated from corrected parent records | 34 |
| Outbound candidates reviewed | 397 |
| Outbound candidates accepted | 361 |
| Outbound candidates withheld | 36 |

The frozen file SHA-256 is `bd82e59880b6c198734b7c9291c86dd526deaa8e0a8eea86659619c5270ff1c3`. These counts describe the research freeze before application integration, URL normalization, or deduplication. The [integrated catalog](local-act-links-catalog.json) collapses two equivalent trailing-slash URL duplicates, producing 725 link entries across the same 298 positive records.

## Method and ownership corrections

The collector reused established catalog identity anchors, cached pages, and observed source links. The initial collector made zero search queries. Its pre-audit retrieval statistics record 349 unique fetched URLs: 337 HTTP 200 responses and 12 failed or non-200 responses. These figures describe collector retrievals, not the separate audit requests or total model tokens.

The initial low-reasoning approach incorrectly treated some page links as artist-owned destinations. The corrective ownership pass evaluated 189 URL decisions spanning 173 custom websites: 96 artist-owned, 79 third-party identity-only, and 14 unresolved. Third-party reporting can support identity without making publisher navigation or footer accounts artist profiles. All 14 unresolved website candidates retain explicit research gaps.

The preceding Astra auditor inspected all 397 outbound candidates in source context, rather than granting ownership to every destination on an artist site. The 36 withheld candidates include individual band-member accounts, separate side projects, lineup performers, a theme vendor, Facebook groups without established artist ownership, ambiguous YouTube identities, and a malformed YouTube path. Accepted links retain source URLs, evidence, platform kinds, and check dates.

Two earlier anchors were also removed: the generic Timmy G home page for Fast & Vengefully, and a conflicting legacy Loud Graves Spotify ID. The dedicated Fast & Vengefully project source and currently official-linked Loud Graves identity remain supported.

## Pilot comparison and independent sample

The pilots cover Modern Monsters, Sour Widows, and Swingin Utters. The independent medium-reasoning pilot supplied five links; the retained union contains nine verified artist-and-URL pairs, including the Sour Widows official website. All nine are present in the frozen input. The initial low-reasoning pilot artifact changed during corrections and union assembly, so this is an artifact and evidence comparison, not a controlled experiment in model quality or token cost. No actual model token counts or costs were measured.

The preceding independent audit selected 30 positive records using ascending SHA-256 of a fixed seed and artist ID, plus three negative records. Their refresh list contains 31 source URLs because some records require multiple sources and aliases reuse parent sources. All 31 cached refreshes returned HTTP 200. A successful response supports accessibility; it does not establish exact artist identity or ownership by itself.

The positive review found that the solo Indianna Hale Bandcamp profile did not establish the exact billed ensemble Indianna Hale And The Dust Collector. Its links were removed and its status became identity-uncertain. Nine previously flagged catalog identities were reviewed; Sunblind's exact Oakland hardcore track identity was supported while unestablished combined or ensemble identities remain withheld.

The original three negative samples were Greenway North, Brassica, and Rozzi. Additional bounded checks recovered Brassica's dedicated band website and Rozzi's official website, artist-linked social profiles, Spotify, and a followed Apple Music redirect. Greenway North remains unresolved. These recoveries show that a negative result from bounded reuse is not an exhaustive absence finding. Additional negative checks did not establish a publishable exact-act identity for Randy Savages or Dead Souls (tribute).

## Final checks and limitations

The finalizer verified unique coverage of all 526 inventory IDs, retained every pilot-union URL, checked both explicit anchor removals, withheld the unverified Indianna ensemble substitution, and propagated all 34 aliases whose parent and alias occur in the inventory. The broader alias mapping has 48 entries; 14 lack both required inventory records and were not propagated. Every retained URL passed protocol and credential checks and has provenance and the audit date.

This audit combines systematic candidate ownership review with a bounded independent sample. It does not prove that every destination is permanently accessible, establish every missing platform profile, or guarantee perfect identity matching. Some accepted catalog anchors are releases rather than general artist home pages, and some older identity evidence was reused. Application integration must separately validate its schema, normalize URLs and gaps, generate the public export, run relevant checks, and verify publication.
