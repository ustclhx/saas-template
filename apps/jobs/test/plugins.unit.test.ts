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
vi.mock('../src/cron/workspace-cleanup.ts', () => ({
  WORKSPACE_CLEANUP_CRON: '0 3 * * *',
  runWorkspaceCleanup: mocks.workspace,
}))

import type { TemplateConfig } from '@saas/config'
import { consumeJobsBatch, type JobsContext, runJobsSchedule } from '../src/handlers.ts'
import { logJobObserver } from '../src/observer.ts'
import type { JobsPluginModule } from '../src/plugins/contract.ts'
import { registerPluginHoldSweepers } from '../src/plugins/register.ts'

const daily = vi.fn()
const heartbeat = vi.fn()
const queue = vi.fn()
const plugins: JobsPluginModule[] = [
  {
    crons: [
      { id: 'a-daily', group: 'daily', run: daily },
      { id: 'a-heartbeat', group: 'heartbeat', run: heartbeat },
    ],
    queues: [{ name: 'agents', handle: queue }],
  },
]
const context = {
  db: { business: () => ({}) },
  files: { available: false },
  observer: logJobObserver,
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
