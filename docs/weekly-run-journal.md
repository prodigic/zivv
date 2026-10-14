# Private run journal and ownership

Next #31 slice, stacked on the run-state foundation. `WeeklyRunJournal` stores validated checkpoints in `weekly-runs.sqlite` under a permanent private operator directory, outside Git. It uses its own schema and never changes the authoritative catalog's schema or data.

The database uses SQLite transactions, WAL and FULL synchronization. Initialization is serialized; a genuinely empty pre-schema file left by process death can initialize again, while unknown schemas/application markers/tables fail closed. Directory permissions are restricted for the operator, with POSIX database mode 0600; linked database/WAL/SHM paths are refused, including dangling links.

An ownership scope identifies one publication destination. `acquire` refuses an active owner; expired/released ownership can be taken over with a higher fencing token. `renew` and `release` require the current unexpired owner. Every journal write checks ownership and uses an atomic expected-revision update. Writes must equal exactly one allowed transition from the stored checkpoint, so callers cannot rewrite successful history by supplying a plausible serialized state.

`create` reuses an existing run rather than reset it. `load` validates the payload and relational identity/revision. A persisted running stage stays running after reopening or process death. Recovery must inspect durable side effects and report a valid outcome; it cannot restart the stage blindly.

This is local coordination over one private database, not a distributed lock across independent machines/stores. The selected cloud/Pi installation must use one authoritative operator installation. Fencing prevents stale checkpoint/acknowledgement writes; external import/deployment side effects still need guarded execution and recovery inspection in the forthcoming runner. Hold/renew the lease during work and stop on lost ownership. Clock and expired-lease handling are explicit operator concerns; lease expiry alone does not prove an external operation failed.

The journal database is not included in the current catalog-only encrypted snapshot. #36 must bundle journal/evidence/report recovery with catalog and versioned weekly/configuration state before activation. No runtime is scheduled, no journal is initialized in the real operator store by this checkpoint, and existing manual Friday commands remain unchanged.

Tests use private temporary stores and cover competing process initialization, pre-schema recovery, reopen, stale/skip writes, owner renewal/takeover/fencing, destination binding, corrupt fencing rows and a real process killed after committing a running checkpoint. POSIX permission/dangling-link assertions run on non-Windows platforms; Windows exercises operator ACL handling through the same helper.
