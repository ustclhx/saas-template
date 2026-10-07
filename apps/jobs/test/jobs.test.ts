import { createScheduledController, introspectWorkflowInstance } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { createDb, readLastCronAt } from '@saas/db'
import { MEDIA_DONE_EVENT } from '@saas/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_CRON } from '../src/cron/heartbeat.ts'
import worker from '../src/index.ts'

describe('apps/jobs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('心跳 Cron 把运行时间写入 jobs.lastCronAt', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const before = Date.now()
    const controller = createScheduledController({
      scheduledTime: new Date(),
      cron: HEARTBEAT_CRON,
    })
    await worker.scheduled(controller, env)

    const lastCronAt = await readLastCronAt(createDb(env.HYPERDRIVE))
    expect(lastCronAt).not.toBeNull()
    expect(Date.parse(lastCronAt ?? '')).toBeGreaterThanOrEqual(before - 1_000)
    expect(log.mock.calls.flat().join(' ')).toContain('cron.heartbeat')
  })

  it('未知的 Cron 表达式报错', async () => {
    const controller = createScheduledController({ cron: '0 0 * * *' })
    await expect(worker.scheduled(controller, env)).rejects.toThrow('Unknown cron')
  })

  it('缺少必需绑定时拒绝处理事件，错误只含变量名', async () => {
    const controller = createScheduledController({ cron: HEARTBEAT_CRON })
    const broken = { ...env, HYPERDRIVE: undefined } as unknown as Cloudflare.Env
    const error = await worker.scheduled(controller, broken).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Invalid environment: missing HYPERDRIVE')
  })

  it('AiMediaWorkflow 执行示例 step 后等待回调事件，收到事件后完成', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = crypto.randomUUID()
    const instance = await introspectWorkflowInstance(env.AI_MEDIA_WORKFLOW, id)
    try {
      await instance.modify(async (m) => {
        await m.mockEvent({ type: MEDIA_DONE_EVENT, payload: { status: 'succeeded' } })
      })

      await env.AI_MEDIA_WORKFLOW.create({ id, params: { taskId: 'task-1' } })

      expect(await instance.waitForStepResult({ name: 'submit' })).toEqual({
        submittedAt: expect.any(String),
      })
      await instance.waitForStatus('complete')
      expect(await instance.getOutput()).toEqual({
        taskId: 'task-1',
        submittedAt: expect.any(String),
        status: 'succeeded',
      })
    } finally {
      await instance.dispose()
    }
  })
})

it('heartbeat retries committed deletion invalidation using the shared CACHE binding', async () => {
  const db = createDb(env.HYPERDRIVE)
  const id = crypto.randomUUID()
  const key = `revoked-${id}`
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await env.CACHE.put(`auth:${key}`, 'stale-session')
  await db.$client`insert into verification (id,identifier,value,expires_at,created_at,updated_at)
    values (${id},${`deletion-cleanup:${id}`},${JSON.stringify([key])},now()+interval '1 hour',now(),now())`
  try {
    await worker.scheduled(createScheduledController({ cron: HEARTBEAT_CRON }), env)
    expect(await env.CACHE.get(`auth:${key}`)).toBeNull()
    expect(
      await db.query.verification.findFirst({ where: (v, { eq }) => eq(v.id, id) }),
    ).toBeUndefined()
  } finally {
    await env.CACHE.delete(`auth:${key}`)
    await db.$client`delete from verification where id=${id}`
  }
})
