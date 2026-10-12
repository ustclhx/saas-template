import { createHash } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'

const activeStatuses = ['pending', 'queued', 'running', 'waiting']
const terminalStatuses = ['completed', 'failed', 'terminated']
const pollMs = 200

export function nextSlot(cron, timeZone, after) {
  return CronExpressionParser.parse(cron, {
    tz: timeZone,
    currentDate: new Date(after),
  }).next().toDate()
}

function latestSlot(cron, timeZone, now) {
  return CronExpressionParser.parse(cron, {
    tz: timeZone,
    currentDate: new Date(now.getTime() + 1),
  }).prev().toDate()
}

// 固定 namespace 的 UUIDv5，使提交任务前后进程退出都能找回同一槽位。
function runId(scheduleId, slot) {
  const namespace = Buffer.from('71e27a53817c5e33bd17c771a7402971', 'hex')
  const bytes = createHash('sha1')
    .update(namespace)
    .update(JSON.stringify([scheduleId, slot.toISOString()]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function migrateScheduler(sql) {
  await sql`create table if not exists spike.schedule (
    id text primary key,
    cron text not null,
    time_zone text not null,
    missed_run text not null check (missed_run in ('skip', 'once')),
    cursor timestamptz not null,
    params jsonb not null default '{}'::jsonb
  )`
  await sql`create table if not exists spike.schedule_run (
    id text primary key,
    schedule_id text not null references spike.schedule(id),
    scheduled_at timestamptz not null,
    status text not null,
    started_at timestamptz,
    finished_at timestamptz,
    params jsonb not null default '{}'::jsonb,
    unique (schedule_id, scheduled_at)
  )`
  await sql`create unique index if not exists schedule_one_active_run
    on spike.schedule_run (schedule_id)
    where status in ('pending', 'queued', 'running', 'waiting')`
  await sql`create table if not exists spike.setting (
    key text primary key,
    value jsonb not null
  )`
}

export async function registerSchedules(sql, definitions) {
  // 先校验所有定义，避免无效 cron 导致部分注册。
  for (const definition of definitions) {
    if (!definition.id || !['skip', 'once'].includes(definition.missedRun)) {
      throw new Error('Invalid scheduler definition')
    }
    nextSlot(definition.cron, definition.timeZone, new Date())
  }
  await sql.begin(async (tx) => {
    for (const definition of definitions) {
      await tx`insert into spike.schedule (id, cron, time_zone, missed_run, cursor, params)
        values (${definition.id}, ${definition.cron}, ${definition.timeZone},
          ${definition.missedRun}, clock_timestamp(), ${tx.json(definition.params ?? {})})
        on conflict (id) do update set
          cron = excluded.cron,
          time_zone = excluded.time_zone,
          missed_run = excluded.missed_run,
          params = excluded.params`
    }
  })
}

export async function startScheduler({ sql, adapter, workerId, definitions }) {
  const startedAt = new Date()
  const rows = definitions ?? (await sql`select id from spike.schedule order by id`)
  const scheduleIds = [...new Set(rows.map((row) => row.id))].sort()
  let stopped = false
  let timer
  let wake

  async function claim(scheduleId) {
    return sql.begin(async (tx) => {
      const [schedule] = await tx`select * from spike.schedule
        where id = ${scheduleId} for update`
      if (!schedule) throw new Error('Unregistered schedule')
      const [{ now }] = await tx`select clock_timestamp() as now`
      const [active] = await tx`select * from spike.schedule_run
        where schedule_id = ${scheduleId} and status in ${tx(activeStatuses)}
        order by scheduled_at limit 1`

      // skip 启动前的槽位，以及执行尚未完成时已经到达的槽位。
      if (schedule.missed_run === 'skip') {
        const cutoff = active ? now : startedAt
        if (schedule.cursor < cutoff) {
          schedule.cursor = cutoff
          await tx`update spike.schedule set cursor = ${cutoff} where id = ${scheduleId}`
        }
      }
      if (active) return active
      const first = nextSlot(schedule.cron, schedule.time_zone, schedule.cursor)
      if (first > now) return undefined
      const slot = latestSlot(schedule.cron, schedule.time_zone, now)
      // skip 也丢弃严重延迟的槽位；短 cron 用 1 秒宽限容纳 200ms 轮询。
      const skip = schedule.missed_run === 'skip' && now - slot >= 1000
      await tx`update spike.schedule set cursor = ${slot} where id = ${scheduleId}`
      if (skip) return undefined
      const id = runId(scheduleId, slot)
      const params = {
        ...schedule.params,
        scheduleId,
        scheduledAt: slot.toISOString(),
      }
      const [run] = await tx`insert into spike.schedule_run
        (id, schedule_id, scheduled_at, status, params)
        values (${id}, ${scheduleId}, ${slot}, 'pending', ${tx.json(params)})
        returning *`
      return run
    })
  }

  async function reconcile(run) {
    let state
    try {
      state = await adapter.get(run.id)
    } catch (error) {
      if (error.name !== 'WorkflowNotFoundError') throw error
      // 事务已提交的 pending 是恢复意图；并发提交通过固定 UUID 交给引擎去重。
      await adapter.create({ id: run.id, params: run.params })
      return
    }
    if (![...activeStatuses, ...terminalStatuses].includes(state.status)) {
      throw new Error('Unknown workflow status')
    }
    await sql.begin(async (tx) => {
      await tx`select id from spike.schedule where id = ${run.schedule_id} for update`
      // get 在事务外运行；旧快照只能更新它原来的活动行，不能回退终态。
      await tx`update spike.schedule_run set
        status = ${state.status},
        started_at = case when ${['running', 'waiting'].includes(state.status)}
          then coalesce(started_at, clock_timestamp()) else started_at end,
        finished_at = case when ${terminalStatuses.includes(state.status)}
          then clock_timestamp() else finished_at end
        where id = ${run.id} and status in ${tx(activeStatuses)}`
    })
  }

  const loop = (async () => {
    while (!stopped) {
      for (const scheduleId of scheduleIds) {
        if (stopped) break
        try {
          const run = await claim(scheduleId)
          if (run) await reconcile(run)
        } catch (error) {
          // 外部数据库错误可能包含连接信息；只打印错误类型。
          console.error(`scheduler ${workerId}: ${error.name}`)
        }
      }
      if (!stopped) {
        await new Promise((resolve) => {
          wake = resolve
          timer = setTimeout(resolve, pollMs)
        })
      }
    }
  })()

  return async function stop() {
    stopped = true
    clearTimeout(timer)
    wake?.()
    await loop
  }
}
