# Friday monitor evidence

The monitor planner creates a deduplication key and a fixed notice payload from one evidence-backed observation of a named Friday edition. It has no clock, mailbox connection, delivery credentials, or scheduling entry point.

- A completed mailbox scan can support a missing-source notice only when it proves absence through Friday 18:00 in America/Los_Angeles. An incomplete or failed scan supplies unknown evidence. A fresh scan can establish absence after Friday while the edition is still unresolved.
- A missed-start notice requires an independent watcher with an explicit expected-start time and a fresh observation that covers that instant. A runner's own lease or an unreachable host alone cannot supply that evidence. An independently readable run record or another reviewed start signal is required.
- The evidence adapter supplies the current time and maximum acceptable observation age. Evidence at the due time and at the age limit is accepted. Stale evidence yields no notice, and malformed or future observations fail closed.
- Repeated evidence for the same edition, notice kind, and due time produces the same payload and key. The payload contains only those fields and a schema version.

The planner leaves `weekly:run-import` and the manual acquisition and publication path unchanged. It needs an authenticated evidence adapter, a durable notification store and an independent watcher before use. Delivery also needs private credentials and a way to reconcile a send whose result is unknown. Successful-release notices require separate live-and-recorded publication evidence.

A separate verified-release inspection prepares evidence for one success notice
per edition. It checks the native acknowledgement at its canonical control
ancestor, the exact candidate and its live verification, and the matching
published cutoff and membership in the weekly ledger. Current production control
must be idle on that release. During another rollout, or after rollback or a
newer publication, the inspector refuses to announce a stale release.

The inspection returns the verified live link, exact count of additions, and
edition-scoped deduplication key. It performs no promotion append, ledger write,
or send. A later adapter must still attach the relevant coverage gaps and
reconcile delivery.
