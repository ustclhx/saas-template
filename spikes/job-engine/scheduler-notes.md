# Shared scheduler spike

`migrateScheduler(sql)` runs DDL with the migrator. The caller creates `spike`
first. `registerSchedules(sql, definitions)` validates cron expressions and stores
definitions. Registration preserves an existing cursor; schedule changes take
effect on the next claim. Runtime `startScheduler({sql, adapter, workerId,
definitions})` runs no DDL and returns an async `stop` function. Omit definitions
to load all registered schedule IDs; supplied definitions select IDs already
registered. A process does not dynamically discover new IDs.

cron-parser 5.6.0 interprets the configured IANA time zone, including DST. Both
the ledger timestamp and reserved workflow payload `scheduledAt` use UTC.
`nextSlot(cron, timeZone, after)` returns the next strictly later `Date`.

Each claim locks the schedule row in a transaction. A partial unique index also
limits each schedule to one pending/queued/running/waiting ledger row. This slot
remains active through workflow completion, failure, or termination, including
durable sleep and event wait. The ledger persists the exact workflow payload,
including `scheduleId` and `scheduledAt`; these reserved fields override caller
params. UUIDv5 derives from a fixed namespace and schedule ID plus UTC slot.

Engine calls happen outside the database transaction. A committed pending row
survives a crash before `adapter.create`; reconciliation recreates that same UUID
only when `adapter.get` throws `WorkflowNotFoundError`. Concurrent publishers
may call create for the same UUID, so the adapter must provide idempotent create.
An unavailable engine leaves the pending row intact and blocks overlapping runs.
State updates reacquire the schedule row lock and update only that run's active
ledger row, so a stale nonterminal snapshot cannot revert a terminal ledger.

`skip` discards slots before process startup, and slots reached while its prior
run is active. A due slot less than one second late is eligible for the 200ms
polling loop; older slots are dropped. `once` retains the cursor while busy and
coalesces missed slots into the latest due slot, both after downtime and after a
long workflow. It never loops through historical cron slots. Stopping preserves
active runs; the next scheduler resumes reconciliation without another slot.

This is a local prototype, not a distributed scheduler product: polling is
sequential, schedule membership is fixed per process, failures are retried at
the next poll without backoff, and timestamps marking observed start/finish
are scheduler observations rather than exact engine timestamps. Clock accuracy
depends on Postgres for slot selection and on process clock for skip startup.
Engine state must have irreversible terminal statuses, and engine retention
must exceed scheduler outage/recovery duration. Schema migration is repeat-safe
for this spike schema; it does not upgrade arbitrary older scheduler schemas.

Runtime requires SELECT/INSERT/UPDATE on the three spike tables; migrator needs
schema DDL privileges. `spike.setting` is available for root-owned heartbeat or
settings handling; this scheduler does not modify it.
