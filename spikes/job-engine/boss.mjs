import pgUtils from 'pg/lib/utils.js'
import { PgBoss } from 'pg-boss'
import { createHash } from 'node:crypto'
import { executeInDrizzle } from './drizzle-bridge.mjs'

const queues = ['main', 'limited', 'other']
const terminal = new Set(['completed', 'failed', 'terminated'])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorData = error => ({ name: error.name, message: error.message })
const storedError = data => Object.assign(new Error(data?.message || 'Workflow failed'), { name: data?.name || 'Error' })
const workflowJobId = id => {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id
  const bytes = createHash('sha256').update(`pg-boss-workflow:${id}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const dbAdapter = sql => ({
  async executeSql(text, values = []) {
    if (typeof sql.execute === 'function') return executeInDrizzle(sql, text, values)
    const reserved = /^\s*BEGIN;/i.test(text) && typeof sql.reserve === 'function' ? await sql.reserve() : null
    try {
      const result = await (reserved || sql).unsafe(text, values.map(value=>pgUtils.prepareValue(value)))
      // postgres.js returns a Result[] for multi-statement plans; pg-boss expects rows.
      const rows = Array.isArray(result[0]) ? [...result].reverse().find(rows => rows.length) || [] : result
      return { rows }
    } catch (error) {
      if (reserved) await reserved.unsafe('ROLLBACK').catch(() => {})
      throw error
    } finally { reserved?.release() }
  },
})

export async function makeAdapter({ sql, workerId, handlers }) {
  // Runtime uses the caller's restricted postgres.js pool, including caller transactions.
  const options = {
    db: dbAdapter(sql), schema: 'pgboss', migrate: false, createSchema: false,
    schedule: false, supervise: true, superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1, maintenanceIntervalSeconds: 60, reindex: false, monitorVacuum: false,
  }
  const boss = new PgBoss(options)
  boss.on('error', error => console.error(JSON.stringify({ worker: workerId, engine: 'boss', error: errorData(error) })))
  let stopping = false

  async function migrate() {
    const migrator = new PgBoss({ ...options, migrate: true, createSchema: true, supervise: false })
    migrator.on('error', () => {})
    await migrator.start()
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS spike.boss_workflow (
        id text PRIMARY KEY, params jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
        output jsonb, error jsonb, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS spike.boss_step (
        workflow_id text REFERENCES spike.boss_workflow(id), name text,
        kind text NOT NULL, status text NOT NULL DEFAULT 'pending', output jsonb,
        error jsonb, attempts integer NOT NULL DEFAULT 0, deadline timestamptz,
        retry_at timestamptz, PRIMARY KEY(workflow_id,name)
      );
      CREATE TABLE IF NOT EXISTS spike.boss_event (
        id bigserial PRIMARY KEY, workflow_id text REFERENCES spike.boss_workflow(id),
        type text NOT NULL, payload jsonb, at timestamptz NOT NULL DEFAULT now(), consumed_by text
      );
      CREATE TABLE IF NOT EXISTS spike.boss_rate (
        queue text PRIMARY KEY, starts timestamptz[] NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS spike.boss_slot (
        id uuid PRIMARY KEY, expires_at timestamptz NOT NULL
      );
      INSERT INTO spike.boss_rate(queue) VALUES ('limited') ON CONFLICT DO NOTHING;
    `)
    await migrator.createQueue('dead', { retryLimit: 0 })
    for (const queue of queues) {
      const config = {
        retryLimit: 5, retryDelay: 30, retryBackoff: false, deadLetter: 'dead',
        heartbeatSeconds: 10, expireInSeconds: 86400,
      }
      await migrator.createQueue(queue, config)
      await migrator.updateQueue(queue, config)
    }
    await migrator.createQueue('workflow', {
      retryLimit: 1000, retryDelay: 1, retryBackoff: false,
      heartbeatSeconds: 10, expireInSeconds: 86400,
    })
    await migrator.stop()
  }

  async function live(id) {
    const [workflow] = await sql`SELECT * FROM spike.boss_workflow WHERE id=${id}`
    if (!workflow) throw Object.assign(new Error('Workflow not found'), { name: 'WorkflowNotFoundError', code: 'NOT_FOUND' })
    if (workflow.status === 'terminated') throw Object.assign(new Error('Workflow terminated'), { name: 'TerminatedError' })
    if (stopping) throw Object.assign(new Error('Worker stopping'), { name: 'WorkerStoppingError' })
    return workflow
  }

  async function journal(id, name, kind, timeoutMs) {
    const rows = await sql`
      INSERT INTO spike.boss_step(workflow_id,name,kind,deadline)
      VALUES (${id},${name},${kind},${timeoutMs == null ? null : new Date(Date.now() + timeoutMs)})
      ON CONFLICT (workflow_id,name) DO UPDATE SET name=excluded.name RETURNING *
    `
    if (rows[0].kind !== kind) throw new Error(`Step ${name} changed kind`)
    return rows[0]
  }

  async function finish(id, name, output) {
    const value = output === undefined ? null : output
    await sql`UPDATE spike.boss_step SET status='completed',output=${sql.json(value)} WHERE workflow_id=${id} AND name=${name}`
    return value
  }

  function steps(id) {
    return {
      async do(name, optionsOrCallback, callback) {
        const config = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback || {}
        const fn = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
        await live(id)
        let state = await journal(id, name, 'do', config.timeoutMs)
        if (state.status === 'completed') return state.output
        if (state.status === 'failed') throw storedError(state.error)
        const retries = config.retries || config.retry || config
        const limit = retries.limit ?? 0
        for (;;) {
          await live(id)
          if (state.retry_at && new Date(state.retry_at).getTime() > Date.now()) {
            await pause(Math.min(200, new Date(state.retry_at).getTime() - Date.now()))
            continue
          }
          const remaining = state.deadline ? new Date(state.deadline).getTime() - Date.now() : null
          try {
            if (remaining != null && remaining <= 0) throw Object.assign(new Error(`Step ${name} timed out`), { name: 'StepTimeoutError' })
            const [next] = await sql`UPDATE spike.boss_step SET attempts=attempts+1,status='running' WHERE workflow_id=${id} AND name=${name} RETURNING *`
            state = next
            let timer
            try {
              const operation = Promise.resolve().then(fn)
              const output = remaining == null ? await operation : await Promise.race([
                operation,
                new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`Step ${name} timed out`), { name: 'StepTimeoutError' })), remaining) }),
              ])
              await live(id)
              return await finish(id, name, output)
            } finally { clearTimeout(timer) }
          } catch (error) {
            if (error.name === 'TerminatedError' || error.name === 'WorkerStoppingError') throw error
            const exhausted = state.attempts > limit || error.name === 'NonRetryableError' || error.name === 'StepTimeoutError'
            const factor = retries.backoff === true || retries.backoff === 'exponential'
              ? 2 ** Math.max(0, state.attempts - 1)
              : retries.backoff === 'linear' ? state.attempts : 1
            const retryAt = new Date(Date.now() + (retries.delayMs ?? 0) * factor)
            const [next] = await sql`UPDATE spike.boss_step SET status=${exhausted ? 'failed' : 'pending'},error=${sql.json(errorData(error))},retry_at=${retryAt} WHERE workflow_id=${id} AND name=${name} RETURNING *`
            state = next
            if (exhausted) throw error
          }
        }
      },
      async sleep(name, durationMs) {
        await live(id)
        const state = await journal(id, name, 'sleep', durationMs)
        if (state.status === 'completed') return
        await sql`UPDATE spike.boss_workflow SET status='waiting',updated_at=now() WHERE id=${id} AND status != 'terminated'`
        while (Date.now() < new Date(state.deadline).getTime()) {
          await live(id)
          await pause(Math.min(200, new Date(state.deadline).getTime() - Date.now()))
        }
        await live(id)
        await finish(id, name, null)
        await sql`UPDATE spike.boss_workflow SET status='running',updated_at=now() WHERE id=${id} AND status != 'terminated'`
      },
      async waitForEvent(name, { type, timeoutMs }) {
        await live(id)
        const state = await journal(id, name, 'event', timeoutMs)
        if (state.status === 'completed') return { ...state.output, timestamp: new Date(state.output.timestamp) }
        if (state.status === 'failed') throw storedError(state.error)
        await sql`UPDATE spike.boss_workflow SET status='waiting',updated_at=now() WHERE id=${id} AND status != 'terminated'`
        for (;;) {
          await live(id)
          const event = await sql.begin(async tx => {
            // Lock the workflow first, matching sendEvent/terminate, for a persistent FIFO inbox.
            const [workflow] = await tx`SELECT status FROM spike.boss_workflow WHERE id=${id} FOR UPDATE`
            if (workflow.status === 'terminated') throw Object.assign(new Error('Workflow terminated'), { name: 'TerminatedError' })
            const [found] = await tx`SELECT * FROM spike.boss_event WHERE workflow_id=${id} AND type=${type} AND consumed_by IS NULL AND (${state.deadline}::timestamptz IS NULL OR at <= ${state.deadline}) ORDER BY id LIMIT 1 FOR UPDATE`
            if (!found) return null
            const result = { type: found.type, payload: found.payload, timestamp: new Date(found.at) }
            await tx`UPDATE spike.boss_event SET consumed_by=${name} WHERE id=${found.id}`
            await tx`UPDATE spike.boss_step SET status='completed',output=${tx.json(result)} WHERE workflow_id=${id} AND name=${name}`
            return result
          })
          if (event) {
            await sql`UPDATE spike.boss_workflow SET status='running',updated_at=now() WHERE id=${id} AND status != 'terminated'`
            return event
          }
          if (state.deadline && Date.now() >= new Date(state.deadline).getTime()) {
            const error = Object.assign(new Error(`Wait ${name} timed out`), { name: 'WaitTimeoutError' })
            await sql`UPDATE spike.boss_step SET status='failed',error=${sql.json(errorData(error))} WHERE workflow_id=${id} AND name=${name}`
            throw error
          }
          await pause(200)
        }
      },
    }
  }

  async function quota(jobs) {
    for (;;) {
      if (stopping) throw new Error('Worker stopping')
      const delay = await sql.begin(async tx => {
        await tx`SELECT queue FROM spike.boss_rate WHERE queue='limited' FOR UPDATE`
        await tx`DELETE FROM spike.boss_slot WHERE expires_at < clock_timestamp()`
        const [active] = await tx`SELECT count(*)::int AS n FROM spike.boss_slot`
        if (active.n + jobs.length > 2) return 100
        const [row] = await tx`
          UPDATE spike.boss_rate SET starts=ARRAY(SELECT t FROM unnest(starts) t WHERE t > clock_timestamp()-interval '10 seconds')
          WHERE queue='limited' RETURNING starts
        `
        if (row.starts.length + jobs.length <= 3) {
          for (const job of jobs) {
            await tx`UPDATE spike.boss_rate SET starts=array_append(starts,clock_timestamp()) WHERE queue='limited'`
            await tx`INSERT INTO spike.boss_slot(id,expires_at) VALUES (${job.id},clock_timestamp()+interval '10 seconds')`
          }
          return 0
        }
        return Math.max(1, new Date(row.starts[0]).getTime() + 10000 - Date.now())
      })
      if (!delay) return
      await pause(Math.min(200, delay))
    }
  }

  async function messages(queue, jobs) {
    let leaseTimer
    if (queue === 'limited') {
      await quota(jobs)
      leaseTimer = setInterval(() => {
        sql.unsafe("UPDATE spike.boss_slot SET expires_at=clock_timestamp()+interval '10 seconds' WHERE id=ANY($1::uuid[])", [jobs.map(job => job.id)]).catch(error => boss.emit('error',error))
      }, 3000)
    }
    try {
      const decisions = new Map()
      let failure
      try {
        await handlers.batch(jobs.map(job => ({
          id: job.id, queue, body: job.data, attempts: job.retryCount + 1,
          timestamp: new Date(job.createdOn),
          ack() { decisions.set(job.id, { ack: true }) },
          retry({ delaySeconds } = {}) { decisions.set(job.id, { delaySeconds }) },
        })))
      } catch (error) { failure = error }
      for (const job of jobs) {
        const decision = decisions.get(job.id)
        await sql.begin(async tx => {
          const db = dbAdapter(tx)
          if (decision?.ack) {
            await boss.complete(queue, job, null, { db })
            return
          }
          const attempts = job.retryCount + 1
          const delay = decision?.delaySeconds ?? Math.min(900, 30 * 2 ** (attempts - 1))
          await boss.fail(queue, job, { reason: failure?.message || 'Explicit retry or unacknowledged message' }, { db })
          if (attempts < 6) {
            // 原生 update 只接受未激活任务；先 fail 到 retry，再在同一事务调整时间。
            const result = await boss.update(queue, undefined, {
              id: job.id, startAfter: Math.ceil(delay), retryDelay: Math.ceil(delay), retryBackoff: false, db,
            })
            if (result.updated !== 1) throw new Error(`Retry scheduling failed for ${job.id}: updated ${result.updated} jobs`)
          } else await tx`INSERT INTO spike.dead_letter(message_id,queue,attempts,reason) VALUES (${job.id},${queue},${attempts},${failure?.message || 'Retries exhausted'}) ON CONFLICT DO NOTHING`
        })
      }
    } finally {
      clearInterval(leaseTimer)
      if (queue === 'limited') await sql.unsafe('DELETE FROM spike.boss_slot WHERE id=ANY($1::uuid[])', [jobs.map(job => job.id)])
    }
  }

  async function start() {
    stopping = false
    await boss.start()
    for (const queue of queues) {
      await boss.work(queue, {
        includeMetadata: true, batchSize: queue === 'limited' ? 2 : 10,
        pollingIntervalSeconds: 5, localConcurrency: queue === 'limited' ? 2 : 8,
        ...(queue === 'limited' ? { groupConcurrency: 2 } : {}),
      }, jobs => messages(queue, jobs))
    }
    await boss.work('workflow', { includeMetadata: true, localConcurrency: 16, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      const id = job.data.id
      try {
        const workflow = await live(id)
        if (terminal.has(workflow.status)) return
        await sql`UPDATE spike.boss_workflow SET status='running',updated_at=now() WHERE id=${id} AND status != 'terminated'`
        const output = await handlers.workflow(workflow.params, steps(id), id)
        await live(id)
        await sql`UPDATE spike.boss_workflow SET status='completed',output=${sql.json(output === undefined ? null : output)},updated_at=now() WHERE id=${id} AND status != 'terminated'`
      } catch (error) {
        if (error.name === 'WorkerStoppingError') throw error
        if (error.name !== 'TerminatedError') await sql`UPDATE spike.boss_workflow SET status='failed',error=${sql.json(errorData(error))},updated_at=now() WHERE id=${id} AND status != 'terminated'`
      }
    })
  }

  async function send({ id, queue = 'main', body, delaySeconds = 0 }, tx) {
    if (!queues.includes(queue)) throw new Error(`Unknown queue ${queue}`)
    return boss.send(queue, body, {
      id, startAfter: delaySeconds,
      ...(queue === 'limited' ? { group: { id: 'limited-global' } } : {}),
      ...(tx ? { db: dbAdapter(tx) } : {}),
    })
  }

  return {
    migrate, start,
    async stop() { stopping = true; await boss.stop({ graceful: true, timeout: 10000 }) },
    send,
    async sendBatch(items, tx) {
      const ids = []
      const enqueue = async transaction => { for (const item of items) ids.push(await send(item, transaction)) }
      if (tx) await enqueue(tx)
      else await sql.begin(enqueue)
      return ids
    },
    async create({ id, params }) {
      await sql.begin(async tx => {
        const rows = await tx`INSERT INTO spike.boss_workflow(id,params) VALUES (${id},${tx.json(params)}) ON CONFLICT DO NOTHING RETURNING id`
        if (rows.length) await boss.send('workflow', { id }, { id: workflowJobId(id), startAfter: params.testDelaySeconds || 0, db: dbAdapter(tx) })
      })
      return id
    },
    async get(id) {
      const [workflow] = await sql`SELECT status,output,error FROM spike.boss_workflow WHERE id=${id}`
      if (!workflow) throw Object.assign(new Error('Workflow not found'), { name: 'WorkflowNotFoundError', code: 'NOT_FOUND' })
      return { status: workflow.status, ...(workflow.output == null ? {} : { output: workflow.output }), ...(workflow.error ? { error: workflow.error } : {}) }
    },
    async sendEvent(id, { type, payload }) {
      return sql.begin(async tx => {
        const [workflow] = await tx`SELECT status FROM spike.boss_workflow WHERE id=${id} FOR UPDATE`
        if (!workflow) throw Object.assign(new Error('Workflow not found'), { name: 'WorkflowNotFoundError', code: 'NOT_FOUND' })
        if (terminal.has(workflow.status)) throw new Error('Workflow is terminal')
        const [event] = await tx`INSERT INTO spike.boss_event(workflow_id,type,payload) VALUES (${id},${type},${tx.json(payload ?? null)}) RETURNING id`
        return event.id
      })
    },
    async terminate(id) {
      await sql.begin(async tx => {
        const [workflow] = await tx`SELECT status FROM spike.boss_workflow WHERE id=${id} FOR UPDATE`
        if (!workflow) throw Object.assign(new Error('Workflow not found'), { name: 'WorkflowNotFoundError', code: 'NOT_FOUND' })
        if (!terminal.has(workflow.status)) await tx`UPDATE spike.boss_workflow SET status='terminated',updated_at=now() WHERE id=${id}`
      })
      await boss.cancel('workflow', workflowJobId(id))
    },
  }
}
