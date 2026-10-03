import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  introspectWorkflowInstance,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { createDb, readLastCronAt } from '@saas/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_CRON } from '../src/cron/heartbeat.ts'
import worker from '../src/index.ts'
import { PROVIDER_CALLBACK_EVENT } from '../src/workflows/ai-media.ts'

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

  it('EMAIL_QUEUE 消费者记录并确认每条消息，日志不含消息体', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const batch = createMessageBatch('email', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: { to: 'someone@example.com' } },
      { id: 'm2', timestamp: new Date(), attempts: 2, body: { to: 'other@example.com' } },
    ])
    await worker.queue(batch, env)
    const result = await getQueueResult(batch, createExecutionContext())
    expect(result.explicitAcks).toEqual(['m1', 'm2'])
    expect(result.retryMessages).toEqual([])

    const logged = log.mock.calls.flat().join('\n')
    expect(logged).toContain('"event":"email.received"')
    expect(logged).toContain('"id":"m2"')
    expect(logged).not.toContain('example.com')
  })

  it('AiMediaWorkflow 执行示例 step 后等待回调事件，收到事件后完成', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = crypto.randomUUID()
    const instance = await introspectWorkflowInstance(env.AI_MEDIA_WORKFLOW, id)
    try {
      await instance.modify(async (m) => {
        await m.mockEvent({ type: PROVIDER_CALLBACK_EVENT, payload: { status: 'succeeded' } })
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
