import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ billing: vi.fn(), cleanup: vi.fn(), db: {} }))
vi.mock('@saas/storage', () => ({ cleanupFiles: mocks.cleanup }))
vi.mock('../src/ai.ts', () => ({}))
vi.mock('../src/billing.ts', () => ({
  BILLING_HOURLY_CRON: '0 * * * *',
  BILLING_RETRY_CRON: '*/10 * * * *',
  BILLING_DAILY_CRON: '0 4 * * *',
  runBillingSchedule: mocks.billing,
}))
vi.mock('../src/queues/billing.ts', () => ({ handleBillingBatch: vi.fn() }))
vi.mock('../src/queues/email.ts', () => ({ handleEmailBatch: vi.fn() }))
vi.mock('../src/cron/deletion-cleanup.ts', () => ({ runDeletionCleanup: vi.fn() }))
vi.mock('../src/cron/heartbeat.ts', () => ({
  HEARTBEAT_CRON: '*/5 * * * *',
  runHeartbeat: vi.fn(),
}))
vi.mock('../src/cron/metrics-daily.ts', () => ({ runMetricsDaily: vi.fn() }))
vi.mock('../src/cron/workspace-cleanup.ts', () => ({
  WORKSPACE_CLEANUP_CRON: '0 3 * * *',
  runWorkspaceCleanup: vi.fn(),
}))

import { type JobsContext, runJobsSchedule } from '../src/handlers.ts'
import { logJobObserver } from '../src/observer.ts'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.billing.mockResolvedValue(undefined)
  mocks.cleanup.mockResolvedValue({ deleted: 1, failed: 0 })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it.each(['billing', 'files'])('runs both ten-minute jobs when %s fails', async (failure) => {
  if (failure === 'billing') mocks.billing.mockRejectedValueOnce(new Error('Billing unavailable'))
  else mocks.cleanup.mockResolvedValueOnce({ deleted: 0, failed: 1 })
  const bucket = { delete: vi.fn() }
  const context = {
    db: { business: () => mocks.db },
    files: { available: true, value: bucket },
    observer: logJobObserver,
  } as unknown as JobsContext
  await expect(runJobsSchedule('*/10 * * * *', new Date(), context)).rejects.toThrow(
    'Ten-minute maintenance cron failed',
  )
  expect(mocks.billing).toHaveBeenCalledOnce()
  expect(mocks.cleanup).toHaveBeenCalledWith(mocks.db, bucket)
})

it('rejects unavailable file storage before opening a database or deleting rows', async () => {
  const business = vi.fn()
  const { runFilesCleanup } = await import('../src/cron/files-cleanup.ts')
  await expect(
    runFilesCleanup({ db: { business, public: business }, files: { available: false } }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', status: 503 })
  expect(business).not.toHaveBeenCalled()
  expect(mocks.cleanup).not.toHaveBeenCalled()
})
