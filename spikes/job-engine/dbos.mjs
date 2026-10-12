import { randomUUID } from 'node:crypto'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { executeInDrizzle } from './drizzle-bridge.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const terminal = new Set(['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])
const databaseUrl = () => {
  const url = new URL('postgresql://localhost')
  url.hostname = process.env.PGHOST || 'localhost'
  url.port = process.env.PGPORT || '5432'
  url.username = process.env.PGUSER || 'postgres'
  url.password = process.env.PGPASSWORD || ''
  url.pathname = `/${process.env.PGDATABASE || 'dbos_spike'}`
  return url.toString()
}

export async function makeAdapter({ sql, workerId, handlers }) {
  let active = false
  let pollPromise
  let workflow
  let batchWorkflow

  const phase = async (id, state) => {
    await sql`insert into spike.dbos_phase (id, state) values (${id}, ${state})
      on conflict (id) do update set state = excluded.state`
  }
  const stepFor = id => ({
    async do(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {} }
      options ||= {}
      const retry = options.retries || options.retry || {}
      if (retry.backoff === 'linear') {
        const maxAttempts = (retry.limit || 0) + 1
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            // 单次失败也持久化；恢复时复用失败记录，再继续持久化等待。
            return await DBOS.runStep(callback, {
              name: `${name}:attempt-${attempt}`,
              retriesAllowed: false,
              maxAttempts: 1,
              timeoutMS: options.timeoutMs,
            })
          } catch (error) {
            if (error?.name === 'NonRetryableError' || attempt === maxAttempts) throw error
            await DBOS.sleep((retry.delayMs ?? 1000) * attempt)
          }
        }
      }
      return DBOS.runStep(callback, {
        name,
        retriesAllowed: (retry.limit || 0) > 0,
        maxAttempts: (retry.limit || 0) + 1,
        intervalSeconds: (retry.delayMs ?? 1000) / 1000,
        backoffRate: typeof retry.backoff === 'number' ? retry.backoff : retry.backoff === 'constant' ? 1 : 2,
        timeoutMS: options.timeoutMs,
        shouldRetry: error => error?.name !== 'NonRetryableError',
      })
    },
    async sleep(name, durationMs) {
      await DBOS.runStep(() => phase(id, 'waiting'), { name: `${name}:waiting` })
      await DBOS.sleep(durationMs)
      await DBOS.runStep(() => phase(id, 'running'), { name: `${name}:running` })
    },
    async waitForEvent(name, { type, timeoutMs }) {
      await DBOS.runStep(() => phase(id, 'waiting'), { name: `${name}:waiting` })
      const event = await DBOS.runStep(async () => {
        // Persist the first deadline; recovery must not restart the timeout.
        await sql`insert into spike.dbos_wait (workflow_id, name, deadline)
          values (${id}, ${name}, clock_timestamp() + ${(timeoutMs ?? 60000)} * interval '1 millisecond') on conflict do nothing`
        for (;;) {
          const signal = DBOS.stepStatus.cancelSignal
          if (signal.aborted) throw signal.reason
          const result = await sql.begin(async tx => {
            const [journal] = await tx`select * from spike.dbos_wait
              where workflow_id = ${id} and name = ${name} for update`
            if (journal.done) return journal.result
            const [pending] = await tx`select seq, event from spike.dbos_event
              where workflow_id = ${id} and type = ${type} and not consumed and to_timestamp((event->>'timestamp')::double precision / 1000) <= ${journal.deadline} order by seq limit 1 for update`
            if (pending) {
              await tx`update spike.dbos_event set consumed = true where seq = ${pending.seq}`
              await tx`update spike.dbos_wait set done = true, result = ${tx.json(pending.event)}
                where workflow_id = ${id} and name = ${name}`
              return pending.event
            }
            const [{ expired }] = await tx`select clock_timestamp() >= ${journal.deadline}::timestamptz expired`
            if (expired) {
              await tx`update spike.dbos_wait set done = true, result = 'null'::jsonb
                where workflow_id = ${id} and name = ${name}`
              return null
            }
            return undefined
          })
          if (result !== undefined) return result
          await pause(100)
        }
      }, { name })
      await DBOS.runStep(() => phase(id, 'running'), { name: `${name}:running` })
      if (event === null) {
        const error = new Error(`Event ${type} timed out`)
        error.name = 'WaitTimeoutError'
        throw error
      }
      // JSON inbox/原生 checkpoint 均可能还原数字；对调用者恢复正式 Date 契约。
      return { ...event, timestamp: new Date(event.timestamp) }
    },
  })

  // Limited batches contain at most two messages so all handler starts have permits.
  // A persisted batch ID owns slots through crash recovery; a recovered step reuses them.
  async function acquireQuota(batchId, count) {
    for (;;) {
      const acquired = await sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(172039, 1)`
        const held = await tx`select n from spike.dbos_quota where batch_id = ${batchId} and active`
        if (held.length) return true
        const [{ n: inflight }] = await tx`select coalesce(sum(n), 0)::int n from spike.dbos_quota where active`
        const [{ n: recent }] = await tx`select coalesce(sum(n), 0)::int n from spike.dbos_quota
          where started_at > clock_timestamp() - interval '10 seconds'`
        if (inflight + count > 2 || recent + count > 3) return false
        await tx`insert into spike.dbos_quota (batch_id, n, active) values (${batchId}, ${count}, true)
          on conflict (batch_id) do update set n = excluded.n, active = true, started_at = clock_timestamp()`
        return true
      })
      if (acquired) return
      await pause(100)
    }
  }

  async function runBatch(batchId, queue) {
    return DBOS.runStep(async () => {
      const rows = await sql`select * from spike.dbos_message where batch_id = ${batchId} and state = 'claimed' order by created_at, id`
      if (!rows.length) return
      if (queue === 'limited') await acquireQuota(batchId, rows.length)
      const choices = new Map()
      const messages = rows.map(row => ({
        id: row.id, queue: row.queue, body: row.body, attempts: row.attempts,
        timestamp: new Date(row.sent_at),
        ack() { choices.set(row.id, { ack: true }) },
        retry({ delaySeconds } = {}) { choices.set(row.id, { delaySeconds }) },
      }))
      let failure
      try { await handlers.batch(messages) } catch (error) { failure = error }
      try {
        await sql.begin(async tx => {
          for (const row of rows) {
            const choice = choices.get(row.id)
            if (choice?.ack) {
              await tx`update spike.dbos_message set state = 'ack' where id = ${row.id} and batch_id = ${batchId}`
            } else if (row.attempts >= 6) {
              await tx`insert into spike.dead_letter (message_id, queue, attempts, reason)
                values (${row.id}, ${row.queue}, ${row.attempts}, ${failure?.message || 'retries exhausted'}) on conflict do nothing`
              await tx`update spike.dbos_message set state = 'dlq' where id = ${row.id} and batch_id = ${batchId}`
            } else {
              const delay = choice?.delaySeconds ?? Math.min(30 * 2 ** (row.attempts - 1), 900)
              await tx`update spike.dbos_message set state = 'pending', batch_id = null,
                available_at = clock_timestamp() + ${delay} * interval '1 second', created_at = clock_timestamp()
                where id = ${row.id} and batch_id = ${batchId}`
            }
          }
          if (queue === 'limited') await tx`update spike.dbos_quota set active = false where batch_id = ${batchId}`
        })
      } catch (error) {
        // Keep owned permits until durable recovery, rather than letting another batch overlap.
        throw error
      }
    }, { name: 'batch-attempt' })
  }

  async function poll() {
    while (active) {
      try {
        for (const queue of ['main', 'limited', 'other']) {
          await sql.begin(async tx => {
            await tx`select pg_advisory_xact_lock(172039, ${queue === 'main' ? 2 : queue === 'limited' ? 3 : 4})`
            const size = queue === 'limited' ? 2 : 10
            const ready = await tx`select id, created_at from spike.dbos_message
              where queue = ${queue} and state = 'pending' and available_at <= clock_timestamp()
              order by created_at, id limit ${size} for update skip locked`
            if (!ready.length || (ready.length < size && Date.now() - new Date(ready[0].created_at).getTime() < 5000)) return
            const batchId = randomUUID()
            await tx`update spike.dbos_message set state = 'claimed', batch_id = ${batchId}, attempts = attempts + 1
              where id in ${tx(ready.map(row => row.id))}`
          })
        }
        // Replay-safe publishing closes the crash window between inbox claim and engine enqueue.
        const batches = await sql`select distinct batch_id, queue from spike.dbos_message where state = 'claimed'`
        for (const batch of batches) {
          await DBOS.startWorkflow(batchWorkflow, { workflowID: batch.batch_id, queueName: `spike-${batch.queue}` })(batch.batch_id, batch.queue)
        }
      } catch (error) {
        // Errors are surfaced without SQL/connection detail that could contain credentials.
        console.error(JSON.stringify({ engine: 'dbos', worker: workerId, pollError: error.name }))
      }
      await pause(200)
    }
  }

  return {
    async migrate() {
      await DBOS.migrate(databaseUrl(), { applicationRole: 'app' })
      await sql`create table if not exists spike.dbos_message (
        id text primary key, queue text not null, body jsonb not null, attempts int not null default 0,
        state text not null default 'pending', batch_id text,
        created_at timestamptz not null default clock_timestamp(), available_at timestamptz not null default clock_timestamp(),
        sent_at timestamptz not null default clock_timestamp())`
      // 只在显式迁移中补齐旧 inbox；重投改变 created_at，但不改变原始发送时间。
      await sql`alter table spike.dbos_message add column if not exists sent_at timestamptz`
      await sql`update spike.dbos_message set sent_at = created_at where sent_at is null`
      await sql`alter table spike.dbos_message alter column sent_at set default clock_timestamp(), alter column sent_at set not null`
      await sql`create index if not exists dbos_message_ready on spike.dbos_message (state, queue, available_at)`
      await sql`create table if not exists spike.dbos_phase (id text primary key, state text not null)`
      await sql`create table if not exists spike.dbos_quota (
        batch_id text primary key, n int not null, active boolean not null,
        started_at timestamptz not null default clock_timestamp())`
      await sql`create table if not exists spike.dbos_event (
        seq bigserial primary key, workflow_id text not null, type text not null,
        event jsonb not null, consumed boolean not null default false)`
      await sql`create index if not exists dbos_event_pending on spike.dbos_event (workflow_id, type, seq) where not consumed`
      await sql`create table if not exists spike.dbos_wait (
        workflow_id text not null, name text not null, deadline timestamptz not null,
        done boolean not null default false, result jsonb, primary key (workflow_id, name))`
      await sql`grant usage on schema spike to app`
      await sql`grant select, insert, update, delete on all tables in schema spike to app`
      await sql`grant usage, select on all sequences in schema spike to app`
    },
    async start() {
      DBOS.setConfig({ name: 'selfhost-b-spike', systemDatabaseUrl: databaseUrl(),
        executorID: workerId, applicationVersion: 'selfhost-b-5.2.11', runMigrations: false,
        systemDatabasePoolSize: 5, logLevel: 'warn' })
      workflow = DBOS.registerWorkflow(async (params, id) => handlers.workflow(params, stepFor(id), id), { name: 'spike-workflow' })
      batchWorkflow = DBOS.registerWorkflow(runBatch, { name: 'spike-batch' })
      await DBOS.launch()
      for (const queue of ['main', 'limited', 'other', 'workflows']) {
        await DBOS.registerQueue(`spike-${queue}`, { minPollingIntervalMs: 100, onConflict: 'never_update' })
      }
      active = true
      pollPromise = poll()
    },
    async stop() {
      active = false
      await pollPromise
      await DBOS.shutdown({ deregister: true, workflowCompletionTimeoutMS: 1000 })
    },
    async send({ id, queue = 'main', body, delaySeconds = 0 }, tx = sql) {
      if (!['main', 'limited', 'other'].includes(queue)) throw new Error('Unknown queue')
      if (typeof tx === 'function') {
        await tx`insert into spike.dbos_message (id, queue, body, available_at)
          values (${id}, ${queue}, ${tx.json(body)}, clock_timestamp() + ${delaySeconds} * interval '1 second') on conflict do nothing`
      } else {
        await executeInDrizzle(tx, `insert into spike.dbos_message (id, queue, body, available_at)
          values ($1, $2, $3::jsonb, clock_timestamp() + $4 * interval '1 second') on conflict do nothing`,
        [id, queue, JSON.stringify(body), delaySeconds])
      }
      return id
    },
    async sendBatch(messages, tx) {
      const sendAll = async connection => {
        for (const message of messages) await this.send(message, connection)
      }
      if (tx) await sendAll(tx)
      else await sql.begin(sendAll)
    },
    async create({ id, params }) {
      await DBOS.startWorkflow(workflow, { workflowID: id, queueName: 'spike-workflows', enqueueOptions: {delaySeconds: params.testDelaySeconds || 0} })(params, id)
      return id
    },
    async get(id) {
      const result = await DBOS.getWorkflowStatus(id)
      if (!result) { const error = new Error('Workflow does not exist'); error.name = 'WorkflowNotFoundError'; throw error }
      const states = { ENQUEUED: 'queued', DELAYED: 'queued', PENDING: 'running', SUCCESS: 'completed', ERROR: 'failed', CANCELLED: 'terminated', MAX_RECOVERY_ATTEMPTS_EXCEEDED: 'failed' }
      let status = states[result.status]
      if (status === 'running') {
        const rows = await sql`select state from spike.dbos_phase where id = ${id}`
        status = rows[0]?.state || status
      }
      const error = result.error ? { name: result.error.name || 'Error', message: result.error.message || String(result.error) } : undefined
      return { status, output: result.output, error }
    },
    async sendEvent(id, { type, payload }) {
      await sql.begin(async tx => {
        // Read-lock the status row; never change a DBOS-owned system table.
        const rows = await tx`select status from dbos.workflow_status where workflow_uuid = ${id} for update`
        if (!rows.length) { const error = new Error('Workflow does not exist'); error.name = 'WorkflowNotFoundError'; throw error }
        if (terminal.has(rows[0].status)) throw new Error('Workflow is terminal')
        await tx`insert into spike.dbos_event (workflow_id, type, event)
          values (${id}, ${type}, ${tx.json({ type, payload, timestamp: Date.now() })})`
      })
    },
    async terminate(id) {
      await this.get(id)
      await DBOS.cancelWorkflow(id, { cancelChildren: true })
    },
  }
}
