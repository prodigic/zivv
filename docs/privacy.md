# Zivv privacy and anti-surveillance boundary

Zivv is against surveillance capitalism. The application is designed so that a person's searches, filters, navigation, reading choices, and event interests remain private to that person.

## What Zivv does not do

- No account, login, authentication, user profile, or identifying cookie is required.
- No analytics, advertising, session replay, fingerprinting, tracking pixel, or remote error-reporting service is included.
- No user action is uploaded for tracking, profiling, personalization, or measurement.
- The browser does not send search terms, filter state, route history, cache contents, or generated user IDs to an application endpoint.

## Browser data and requests

Zivv loads static, read-only data files from the same application origin. The browser may retain the event dataset in IndexedDB and preferences in local storage so the app can work efficiently. These are local cache/preferences, not synchronized profiles. The currently approved preference keys are:

- `darkMode` — the local color preference;
- `zivv-debug-mode` — the local development/debug display preference;
- `zivv-filters` — the local filter/search/sort preference state;
- the versioned IndexedDB cache used for static dataset data.

Search submission keeps the search state in the browser/store rather than placing it in the HTTP query string. Query strings can be sent to the hosting server in request URLs and can appear in server logs or referrers.

The filter store still contains legacy `syncToURL`/`syncFromURL` helpers for compatibility tests. They are not wired to application navigation in this workstream. A later UI/query integration task should either remove those helpers or convert them to an explicitly client-only fragment format before adding shareable filters.

The application request boundary permits same-origin `GET` and `HEAD` requests only, with no request body and a `no-referrer` policy. Outbound links may still take a person to a third-party ticket, venue, GitHub, or email service; those destinations have their own policies and are outside Zivv's control.

## The honest network boundary

Zivv does not claim that ordinary network metadata is impossible to observe. Loading a website necessarily exposes transport metadata such as an IP address, timestamp, and user agent to the hosting/network layer. Zivv does not add an application-level record of the user's actions on top of that unavoidable delivery metadata.

## Local errors and diagnostics

Errors and performance measurements stay in the browser and developer console. A local support reference shown in an error screen is not an account identifier and is never transmitted automatically.

## Maintenance rule

Any proposed analytics, advertising, authentication, remote error reporting, behavioral telemetry, session replay, or synchronized personalization must be treated as a product-level privacy decision and is prohibited by default. It must not be added as a “small” implementation detail.
