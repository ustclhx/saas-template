import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// 核心任务全部替换为桩，只验证插件扩展点的合并方式（add-plugin-system 3.5）
const mocks = vi.hoisted(() => ({
  billing: vi.fn(),
  heartbeat: vi.fn(),
  deletion: vi.fn(),
  workspace: vi.fn(),
  metrics: vi.fn(),
  registerHoldSweeper: vi.fn(),
}))
vi.mock('@saas/storage', () => ({ cleanupFiles: vi.fn() }))
vi.mock('@saas/billing', () => ({ registerHoldSweeper: mocks.registerHoldSweeper }))
vi.mock('../src/billing.ts', () => ({
  BILLING_HOURLY_CRON: '0 * * * *',
  BILLING_RETRY_CRON: '*/10 * * * *',
  BILLING_DAILY_CRON: '0 4 * * *',
  runBillingSchedule: mocks.billing,
}))
vi.mock('../src/queues/billing.ts', () => ({ handleBillingBatch: vi.fn() }))
vi.mock('../src/queues/email.ts', () => ({ handleEmailBatch: vi.fn() }))
vi.mock('../src/cron/deletion-cleanup.ts', () => ({ runDeletionCleanup: mocks.deletion }))
vi.mock('../src/cron/heartbeat.ts', () => ({
  HEARTBEAT_CRON: '*/5 * * * *',
  runHeartbeat: mocks.heartbeat,
}))
vi.mock('../src/cron/metrics-daily.ts', () => ({ runMetricsDaily: mocks.metrics }))
vi.mock('../src/cron/admin-confirmations-cleanup.ts', () => ({
  runAdminConfirmationsCleanup: vi.fn(),
}))
vi.mock('../src/cron/workspace-cleanup.ts', () => ({
  WORKSPACE_CLEANUP_CRON: '0 3 * * *',
  runWorkspaceCleanup: mocks.workspace,
}))

import type { TemplateConfig } from '@saas/config'
import { logJobObserver } from '@saas/shared/log'
import { consumeJobsBatch, type JobsContext, runJobsSchedule } from '../src/handlers.ts'
import type { JobsPluginModule } from '../src/plugins/module.ts'
import { registerPluginHoldSweepers } from '../src/plugins/register.ts'

const daily = vi.fn()
const heartbeat = vi.fn()
const queue = vi.fn()
const purge = vi.fn()
const send = vi.fn()
const none = { kind: 'none', reason: '测试任务' } as const
const plugins: JobsPluginModule[] = [
  {
    crons: [
      { id: 'a-daily', group: 'daily', safety: none, run: daily },
      { id: 'a-heartbeat', group: 'heartbeat', safety: none, run: heartbeat },
      {
        id: 'a-purge',
        group: 'ten-minute',
        safety: {
          kind: 'delete',
          cap: 10,
          capUnit: '条',
          order: 'expires_at 升序',
          timeGuard: '下限与数据库时钟',
        },
        run: purge,
      },
    ],
    queues: [{ name: 'agents', handle: queue }],
  },
]
const context = {
  db: { business: () => ({}) },
  files: { available: false },
  observer: logJobObserver,
  eventsQueue: { send, sendBatch: vi.fn() },
  plugins,
} as unknown as JobsContext

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('插件定时任务与同组核心任务一起运行，不影响其他触发器', async () => {
  const at = new Date('2026-11-24T03:00:00Z')
  await runJobsSchedule('0 3 * * *', at, context)
  expect(mocks.workspace).toHaveBeenCalledOnce()
  expect(daily).toHaveBeenCalledExactlyOnceWith(context, at)
  expect(heartbeat).not.toHaveBeenCalled()
  await runJobsSchedule('*/5 * * * *', at, context)
  expect(mocks.heartbeat).toHaveBeenCalledOnce()
  expect(heartbeat).toHaveBeenCalledOnce()
})

it('插件删除任务的防护结果按任务 + 原因 + UTC 日上报，到达上限记警告', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  purge.mockResolvedValue({
    guard: {
      processed: 10,
      capReached: true,
      tripped: [{ reason: 'rows-out-of-range', count: 3 }],
    },
  })
  const at = new Date('2026-11-24T03:10:00Z')
  await runJobsSchedule('*/10 * * * *', at, context, { skipUnavailableFiles: true })
  await runJobsSchedule('*/10 * * * *', at, context, { skipUnavailableFiles: true })
  expect(purge).toHaveBeenCalledTimes(2)
  const events = send.mock.calls.map(([body]) => body.operations[0])
  expect(events).toHaveLength(2)
  // 两次运行的 sourceId 相同，运维通知消费者按审计标记只投递一次
  expect(new Set(events.map((event) => event.sourceId)).size).toBe(1)
  expect(events[0]).toMatchObject({
    event: 'ops.bulk_job.guard_tripped',
    sourceId: expect.stringMatching(/^bulk_job:a-purge:rows-out-of-range:\d{4}-\d{2}-\d{2}$/),
    count: 3,
  })
  expect(warn.mock.calls.flat().join('\n')).toContain('job.cap_reached')
})

it('插件任务失败时核心任务仍完成，本次触发记为失败', async () => {
  daily.mockRejectedValueOnce(new Error('plugin down'))
  await expect(runJobsSchedule('0 3 * * *', new Date(), context)).rejects.toThrow(
    'Cron 0 3 * * * with plugin tasks failed',
  )
  expect(mocks.workspace).toHaveBeenCalledOnce()
  expect(mocks.metrics).toHaveBeenCalledOnce()
})

it('插件声明的队列交给插件消费，未知队列仍报错', async () => {
  const batch = { queue: 'agents-staging', messages: [] }
  await consumeJobsBatch(batch as never, context)
  expect(queue).toHaveBeenCalledExactlyOnceWith(batch, context)
  await expect(
    consumeJobsBatch({ queue: 'other', messages: [] } as never, context),
  ).rejects.toThrow('Unknown queue: other')
})

it('插件的积分预扣清理器按来源登记，注销函数逐个注销', () => {
  const unregister = vi.fn()
  mocks.registerHoldSweeper.mockReturnValue(unregister)
  const handler = vi.fn()
  const create = vi.fn(() => handler)
  const template = { billing: {} } as unknown as TemplateConfig
  const dispose = registerPluginHoldSweepers(
    [{ holdSweepers: [{ refType: 'ai_task', create }] }, {}],
    template,
  )
  expect(create).toHaveBeenCalledWith(template)
  expect(mocks.registerHoldSweeper).toHaveBeenCalledExactlyOnceWith('ai_task', handler)
  dispose()
  expect(unregister).toHaveBeenCalledOnce()
})
