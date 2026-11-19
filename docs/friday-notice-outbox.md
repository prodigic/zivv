# Friday notification outbox

The outbox records the two notice kinds from the [Friday evidence planner](friday-monitor-evidence.md) in a dedicated SQLite database. This checkpoint exposes a library for isolated rehearsal. The weekly runner and CLI have no notification dispatcher.

```text
Fresh evidence -> pending intent
Pending intent -> commit delivery-unknown claim -> permit one attempt
Separately verified, matching acknowledgement -> sent receipt
```

- The caller provides and closes the database. Initialize a new dedicated database once, during explicit provisioning. Reopening checks the exact schema and existing records without running initialization. Keep it in approved private storage, outside the production operator directory whose authenticated inventory does not yet include this database.
- Each operation uses SQLite's immediate write lock. Writes require on-disk journaling and FULL synchronous mode. The provider receives an attempt only after a caller obtains the committed claim; a second caller sees the existing claim and cannot obtain another one.
- After a crash or an unknown response, preserve the exact database and reconcile the claim with the delivery provider. A claim remains unknown even if the process died before calling the provider. Verifying an acknowledgement separately is required before recording the receipt digest. Never recreate a missing database to clear a claim or send again.
- Notice records contain only the bounded notice fields, the local attempt ID, and an optional digest of the verified acknowledgement. The later delivery adapter is responsible for provider idempotency, private identity and credentials, validated receipt evidence, and deciding whether an old pending notice is still actionable.

The isolated tests use private temporary databases and simulated acknowledgements. Independently hosted monitoring, persistent off-host recovery, verified release notices, and external delivery are separate #37 work.

The delivery adapter prepares credentials and the message before claiming. A
preparation failure leaves the intent pending. After a claim commits, it may
invoke its provider once. If that call fails or loses its response, later
invocations only look up a receipt for the same outbox key and attempt ID.
They never issue a second send for an unresolved claim. A confirmed receipt
must bind the exact key, attempt ID, and digest before the outbox records it.

The adapter has no concrete mail provider. Its isolated rehearsal simulates an
accepted delivery with a lost reply, reopens the database, and reconciles the
existing delivery exactly once.

### Gmail provider rehearsal

The Gmail adapter takes explicitly configured sender and recipient addresses,
a separate access-token supplier, and a fetch implementation. The outbox
prepares the authenticated sender before acquiring its durable claim. The
adapter encodes the bounded notice as MIME and uses the claim to derive a stable
RFC Message-ID and notice marker. [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending)

After Gmail accepts the request, the adapter checks the Sent label, sender,
recipient, subject, Message-ID, and marker. For an uncertain send, it searches
Sent by the exact Message-ID and verifies one matching result. Missing,
ambiguous, or inconsistent evidence leaves the claim held.
[Gmail message search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)

The acquisition credential stays read-only. A reviewed notification credential
needs separate send and Sent-read access. The tests use only synthetic HTTP and
disposable databases. Production credential setup, address review and delivery
rehearsal remain prerequisites.
