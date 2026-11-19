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
