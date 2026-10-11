# Single-artist Bandcamp player

The initial pilot uses Sour Widows' **Revival Of A Friend**. Its [official album
page](https://sourwidows.bandcamp.com/album/revival-of-a-friend) identifies the
artist, lists ten tracks and publishes `og:video` with Bandcamp album ID
`1637895938`. Checked on October 10, 2026. This is one album, not a combined
discography or a playlist spanning different artists.

The reviewed release link stores the album ID and title alongside its source
and identity evidence. ETL preserves this optional metadata only after validating
the exact artist ID/name, Bandcamp album URL and numeric embed ID. The UI builds
the iframe URL on the fixed Bandcamp player host; raw HTML is not stored.

Listen mounts the official player on demand with its tracklist. Closing removes
the iframe. Bandcamp handles playback and streaming availability; Zivv does not
download audio, implement an unofficial streaming API or claim external playback
control. A direct album link remains available. The player is available wherever
artist links render, including the artist page and local-artist card.

Model allocation: GPT-6.1 Sol high implemented the UI and focused component tests;
the parent handled source verification, registry/export wiring and integration.
No broad catalog crawl or Astra agent was used for this pilot.

The [official embed guide](https://get.bandcamp.help/en/articles/15263071-how-do-i-create-a-bandcamp-embedded-player)
documents configurable album players. Bandcamp's
[public playlists](https://get.bandcamp.help/en/articles/15263059-playlists-on-the-web-beta)
are a separate fan-account feature and are outside this pilot.
