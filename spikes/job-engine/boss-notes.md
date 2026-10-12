# pg-boss local adapter notes

Prototype only. Own files: `boss.mjs`, `boss-notes.md`. This file records implementation facts, not a claim that the supervisor's scenarios passed.

## Fixed primary sources

Installed npm pg-boss **12.37.1**, artifact integrity `sha512-LghWeOIbMCiLcTY3+8MInXaJ0wk0AOkbeUZ8oE+cGO0uoheGSW3GK57eDqEbrDGpwTIpX9BVphvdvWEDYTcJ9A==`; postgres.js **3.4.9**, integrity `sha512-GD3qdB0x1z9xgFI6cdRD6xu2Sp2WCOEoe3mtnyB5Ee0XrrL5Pe+e4CCnJrRMnL1zYtRDZmQQVbvOttLnKDLnaw==`. Integrity read directly from the independent spike package-lock, untouched by this executor.

Read installed `pg-boss/README.md`, `dist/types.d.ts`, `dist/index.js`, `dist/manager.js`, `dist/plans.js`, `dist/attorney.js`, `dist/boss.js`. These match the pinned package; live documentation is https://pgboss.io/api/workers, https://pgboss.io/api/queues and https://pgboss.io/api/constructor. Key primary-source details:

- `index.js:#doStart`: migrate=false checks schema version; only migrate=true starts migration/BAM. Reindex=false avoids runtime REINDEX.
- `types.d.ts:WorkOptions`: actual batch handler receives an array; missing per-job outcomes normally fail batches. Adapter instead explicitly completes/fails each fetched attempt before returning.
- `manager.js:fail/complete`: fetched job objects fence settlement on id plus retryCount. Adapter passes original fetched objects.
- `types.d.ts:RetryOptions`, `manager.js:failDistributed`: native retryBackoff uses jitter. This contract requires exact doubling, so adapter updates the next native retryDelay individually and disables native jitter.
- `plans.js:updateJob` (lines 3480–3570): public update only targets state < active; an ACTIVE job update silently returns updated=0. Retry settlement must fail the fetched attempt first, then update its RETRY row in the same transaction. `manager.js:update` returns `{ jobs, updated }`, so the adapter requires updated=1 for attempts1–5.
- `plans.js:failJobsByTimeout/failJobsByHeartbeat`: absolute expiry is independent of heartbeat. Adapter uses 86400s absolute expiry and 10s heartbeat, with 1s supervisor/monitor intervals. Crash recovery is driven by missed heartbeats.
- `attorney.js:validateQueueArgs`: heartbeat minimum is 10s.

## Queue implementation

Actual pg-boss queues `main`, `limited`, `other`, `workflow`, `dead`; SQL fetch/locking, native states, native retries, native DLQ, automatic worker heartbeat. Main/other work handlers fetch up to 10 messages every 5s; limited fetches up to 2 every 5s. Main/other have no global policy limit; per-process polling resource concurrency is 8, workflow 16.

Limited jobs share a native group ID and groupConcurrency=2. A supplemental PostgreSQL admission gate serializes on one rate row and atomically reserves the entire real batch: total live callback slots <=2, sliding-window starts <=3 in 10s. Slots have a 10s lease renewed every3s. Batch admission never reserves just its first member, so it cannot deadlock holding half a batch. Full batches of2 may leave the third rate token unused until another batch of1 arrives; the implementation enforces an upper bound, not guaranteed throughput of3.

Common handlers own spike.batch/message_attempt/calls/effects auditing. Adapter records independent ack/retry decisions, then settles each message independently in a transaction. An ack survives another message's retry or handler error. Unacked defaults to retry; 5 retries exclude initial attempt. Delay default30s doubles capped900s; explicit delay uses ceil(seconds). The adapter calls public fail(), then public update() with startAfter, retryDelay and retryBackoff=false inside the same transaction for attempts1–5, asserting updated=1. No direct vendor-table UPDATE is used. At attempt6 a retry becomes native terminal failure/DLQ and inserts spike.dead_letter without updating it. QueueMessage.timestamp is a Date from native createdOn.

send accepts the caller's postgres.js transaction or actual Drizzle DatabaseTransaction through pg-boss's `db.executeSql` interface: enqueue/business write can commit or roll back atomically. Drizzle transactions route through the shared executeInDrizzle parameter-binding bridge; postgres.js runtime plans retain the reserved-connection BEGIN bridge. sendBatch accepts the same optional caller transaction, otherwise enqueues all inputs in its own transaction. No outbox needed for this adapter. Native stable UUID job IDs suppress duplicate queue rows during retained lifetime. Workflow rows preserve arbitrary string business IDs beyond native retention; a non-UUID business ID maps to a deterministic SHA-256-derived UUID for native enqueue/cancel, while the business ID remains in the workflow row and job payload.

## Durable workflow supplementation

Homegrown `boss_workflow`, `boss_step`, `boss_event` tables preserve workflow state, step outputs/errors/attempt counts/retryAt/deadlines, and persistent FIFO inbox. Workflow code replays from the beginning after native recovery; completed do/sleep/wait steps return saved outcomes. Original sleep/event deadlines are inserted once and never reset. Type matching plus event insertion ID gives FIFO; event consumption and step completion share one transaction. Events received after original timeout cannot satisfy a wait. Missing workflows throw WorkflowNotFoundError with code NOT_FOUND; database failures propagate.

NonRetryableError persists a failed step and bypasses retries. Retry limits exclude initial; exponential, linear (delayMs × failed attempt number), and constant retry delays are supported. do(timeoutMs) races callback with the persisted deadline. waitForEvent returns timestamp as a Date on both initial consumption and replay; its JSON journal stores the serialized timestamp. terminate persists terminal status and cancels the mapped native job; polling steps stop within ~200ms. Arbitrary running callbacks are cooperative and cannot be forcibly cancelled.

Maintenance burden / real semantic differences:

- This is a hand-built durable interpreter, not a pg-boss built-in workflow feature. Schema migrations, serialization, replay compatibility, error semantics, leases, retention and observability are application-owned.
- A crash between an external side effect and saved output re-runs that callback. Effects need idempotency keys or an application transaction that includes journaling; the adapter cannot promise exactly-once external effects.
- Timeout/termination cannot cancel arbitrary JavaScript callbacks: timed-out callbacks may still make late side effects. Deadline applies from the first step attempt including retry delays.
- Waits/sleeps retain a worker slot and poll the DB every200ms. It is durable but less efficient than a suspension/re-enqueue engine. Pool=max3 is caller-supplied; callbacks must not hold all connections while waiting for adapter DB writes.
- Callback lease heartbeat and native job heartbeat are two separate mechanisms. Long DB outages or event-loop pauses can expire claims while old user code remains alive; fencing settlement does not fence external effects.
- API outputs must be JSON-serializable; undefined step outputs are normalized to null. No automatic code-version migration.

## Permissions and validation

Migrator: schema/table/type/function DDL privileges, library migration execution and schema ownership. Only migrate() creates app tables and queues. Library SQL plans with explicit BEGIN reserve a postgres.js connection and release it after COMMIT; errors roll back before release. This applies to runtime supervisor expiry/maintenance as well as migration, avoiding postgres.js UNSAFE_TRANSACTION on max3 pools. Multi-statement results are normalized to the last nonempty result set. Runtime uses caller's restricted pool with migrate=false/createSchema=false/schedule=false/reindex=false; start/send/work/get/event/terminate issue no adapter DDL. Grant app USAGE on pgboss/spike schemas, SELECT/INSERT/UPDATE/DELETE on all their tables, USAGE/SELECT on sequences, EXECUTE on pg-boss functions. Runtime needs no CREATE/ALTER/REINDEX grants. Functions' default PUBLIC EXECUTE remains unless supervisor tightens it explicitly.

Preserved failure evidence: the supervisor's initial real six-attempt run had 30-second intervals throughout, rather than the required doubling. The cause was updating an ACTIVE job before fail(), which returned updated=0. This is a failed original observation, not erased or claimed as passing after the correction. The supervisor owns the corrected real-time rerun and its evidence.

Executor verified: `node --check spikes/job-engine/boss.mjs` passed after the targeted corrections. No long scenarios started by executor. Supervisor supplies real Docker Node22/Postgres17 runs and reported audit evidence; Drizzle atomicity, arbitrary workflow IDs, Date timestamps and linear retry timing still require that runtime verification.

Quick smoke under isolated existing Docker network, no ports: mount repository into node:22, set PGHOST=selfhost-b-spike-pg, PGDATABASE=boss_spike, PGUSER=postgres, CANDIDATE=boss, then run `node spikes/job-engine/worker.mjs migrate`; grant runtime permissions separately, then start worker.mjs with PGUSER=app and WORKER_ID=boss-1. The worker uses parent IPC for controls, so full scenarios use the supervisor's driver. Connection details are never printed by adapter.
