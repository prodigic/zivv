# Friday notification outbox

The outbox records alerts from the [Friday evidence planner](friday-monitor-evidence.md) and can also store the evidence for one publication notice per edition in a dedicated SQLite database. This checkpoint exposes a library for isolated rehearsal. The weekly runner and CLI have no notification dispatcher.

```text
Fresh evidence -> pending intent
Pending intent -> commit delivery-unknown claim -> permit one attempt
Separately verified, matching acknowledgement -> sent receipt
```

- The caller provides and closes the database. Initialize a new dedicated database once, during explicit provisioning. Reopening checks the exact schema and existing records without running initialization. Keep it in approved private storage, outside the production operator directory whose authenticated inventory does not yet include this database.
- Each operation uses SQLite's immediate write lock. Writes require on-disk journaling and FULL synchronous mode. The provider receives an attempt only after a caller obtains the committed claim; a second caller sees the existing claim and cannot obtain another one.
- After a crash or an unknown response, preserve the exact database and reconcile the claim with the delivery provider. A claim remains unknown even if the process died before calling the provider. Verifying an acknowledgement separately is required before recording the receipt digest. Never recreate a missing database to clear a claim or send again.
- Notice records contain only the bounded notice fields, the local attempt ID, and an optional digest of the verified acknowledgement. The later delivery adapter is responsible for provider idempotency, private identity and credentials, validated receipt evidence, and deciding whether an old pending notice is still actionable.

### Publication notices

Initialize the dedicated outbox first and use `enablePublicationNotices()` to
explicitly upgrade its schema. The upgrade adds the publication notice table
in one transaction and preserves existing alert claims and receipts. Reopen the
same database with a version that understands the upgraded schema.

Record the release using its persisted acknowledgement and the current production
control. To claim a pending notice, supply a fresh evidence reader for the same
release. Changes to its candidate, manifest, published weekly state or current
release leave the intent pending for review. An edition key stays bound to the
first recorded proof. A later correction with different release evidence raises a
conflict. Reconcile a previously committed attempt against its saved proof and
attempt ID.

The database lock serializes local attempts. A delivery integration still needs
to coordinate with production promotion before sending and verify the provider's
receipt. The rehearsal uses a temporary database and synthetic release evidence.
Coverage-gap rendering, independent hosting and durable off-host recovery remain
part of #37.

### Coverage and delivery

Use `enablePublicationCoverage()` to opt into the coverage-aware schema. It
validates existing publication rows before the upgrade and preserves valid
alert and publication rows, including unknown and sent claims. A new coverage-bearing intent stores the exact verified counts.
An older publication row for the same edition retains its original proof.

The dispatcher rechecks the exact current release and its coverage while
claiming. It checks them again before calling the selected provider. If
authority fails after the claim, the claim stays unknown and the provider
is not called. A later attempt reconciles the exact prior claim through
the provider and does not send again. Gmail reconciliation binds the immutable
release proof and message content to the exact attempt. It checks the Sent
identity and decodes the bounded plain-text body in the same response. The
[full message format](https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format)
requires access beyond metadata alone.

The integrated rehearsal uses synthetic Gmail responses. Production still
needs reviewed provider credentials, private storage and independent
monitoring. Coordinate the sender with the production promotion fence
before enabling unattended delivery.
