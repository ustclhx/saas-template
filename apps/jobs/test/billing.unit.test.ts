import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  runtime: vi.fn(),
  flush: vi.fn(),
  compensation: vi.fn(),
  expiration: vi.fn(),
  annual: vi.fn(),
  hold: vi.fn(),
  subscription: vi.fn(),
  credits: vi.fn(),
  cleanup: vi.fn(),
  heartbeat: vi.fn(),
  workspace: vi.fn(),
  deletion: vi.fn(),
}))
vi.mock('@saas/billing', () => ({
  createTestPaymentRuntime: mocks.runtime,
  flushRefundNotifications: mocks.flush,
  runPendingCompensations: mocks.compensation,
  runCreditExpiration: mocks.expiration,
  runAnnualGrants: mocks.annual,
  runHoldSweep: mocks.hold,
  runSubscriptionReconciliation: mocks.subscription,
  runCreditReconciliation: mocks.credits,
  clearResolvedRefundContacts: mocks.cleanup,
}))
vi.mock('@saas/db', async (original) => ({
  ...(await original<typeof import('@saas/db')>()),
  createDb: mocks.createDb,
}))

vi.mock('../src/workflows/ai-media.ts', () => ({ AiMediaWorkflow: class {} }))
vi.mock('../src/cron/heartbeat.ts', () => ({
  HEARTBEAT_CRON: '*/5 * * * *',
  runHeartbeat: vi.fn(),
}))
vi.mock('../src/cron/deletion-cleanup.ts', () => ({ runDeletionCleanup: vi.fn() }))
vi.mock('../src/cron/workspace-cleanup.ts', () => ({
  WORKSPACE_CLEANUP_CRON: '0 3 * * *',
  runWorkspaceCleanup: vi.fn(),
}))

import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  type BillingEnv,
  createBillingContext,
  postprocessBillingDelivery,
  recoverBillingDeliveries,
  runBillingSchedule,
} from '../src/billing.ts'
import { runDeletionCleanup } from '../src/cron/deletion-cleanup.ts'
import { runHeartbeat } from '../src/cron/heartbeat.ts'
import { runWorkspaceCleanup } from '../src/cron/workspace-cleanup.ts'
import worker from '../src/index.ts'
import { handleBillingBatch } from '../src/queues/billing.ts'

const id = '93f577ac-e28b-4ca3-9768-05d4e2aa5649'
const env = {
  HYPERDRIVE: { connectionString: 'offline' },
  CACHE: {},
  EMAIL_QUEUE: { send: vi.fn() },
} as unknown as BillingEnv
let db: ReturnType<typeof database>
function database() {
  const results: unknown[][] = []
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: Model Drizzle awaitable query builders.
    then: (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(resolve),
  }
  return {
    results,
    query,
    select: vi.fn(() => query),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  }
}
function message(body: unknown) {
  return {
    body,
    id: 'queue-message',
    attempts: 2,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown>
}
beforeEach(() => {
  vi.clearAllMocks()
  db = database()
  mocks.createDb.mockReturnValue(db)
  mocks.runtime.mockReturnValue({ providers: {} })
  mocks.flush.mockResolvedValue({ queued: 0, failures: [] })
  mocks.compensation.mockResolvedValue({ claimed: 0, completed: 0, failed: 0 })
  for (const run of [mocks.expiration, mocks.annual, mocks.hold, mocks.subscription, mocks.credits])
    run.mockResolvedValue({ processed: 0, failures: [] })
  mocks.cleanup.mockResolvedValue({ cleared: 0 })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
describe('billing jobs', () => {
  it('routes hourly, ten-minute and daily jobs and propagates service failures without secrets', async () => {
    await runBillingSchedule(BILLING_HOURLY_CRON, env)
    expect(mocks.expiration).toHaveBeenCalledOnce()
    expect(mocks.annual).toHaveBeenCalledOnce()
    await runBillingSchedule(BILLING_RETRY_CRON, env)
    expect(mocks.hold).toHaveBeenCalledOnce()
    expect(mocks.compensation).toHaveBeenCalledOnce()
    expect(mocks.flush).toHaveBeenCalledOnce()
    mocks.subscription.mockResolvedValue({ processed: 0, failures: [{ error: 'secret=unsafe' }] })
    await expect(runBillingSchedule(BILLING_DAILY_CRON, env)).rejects.toThrow(
      'Billing jobs failed: subscription_reconciliation (1)',
    )
    expect(mocks.credits).toHaveBeenCalledOnce()
    expect(mocks.cleanup).toHaveBeenCalledOnce()
    expect(mocks.runtime).toHaveBeenCalledWith(env, ['stripe', 'paypal'], { cache: env.CACHE })
  })
  it('acks invalid envelopes without initializing providers or touching the database', async () => {
    const messages = [
      message(null),
      message({ v: 2, deliveryId: id }),
      message({ v: 1, deliveryId: 'not-uuid' }),
    ]
    await handleBillingBatch({ messages } as unknown as MessageBatch<unknown>, env)
    for (const entry of messages) {
      expect(entry.ack).toHaveBeenCalledOnce()
      expect(entry.retry).not.toHaveBeenCalled()
    }
    expect(mocks.createDb).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
  it('leaves notification failures unmarked and retries the same persisted delivery successfully', async () => {
    const entry = message({ v: 1, deliveryId: id })
    db.results.push([{ id, status: 'processed' }], [])
    mocks.flush.mockResolvedValueOnce({ queued: 0, failures: ['refund-id'] })
    await handleBillingBatch({ messages: [entry] } as unknown as MessageBatch<unknown>, env)
    expect(entry.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(entry.ack).not.toHaveBeenCalled()
    expect(db.insert).not.toHaveBeenCalled()
    db.results.push([{ id, status: 'processed' }], [])
    await handleBillingBatch({ messages: [entry] } as unknown as MessageBatch<unknown>, env)
    expect(entry.ack).toHaveBeenCalledOnce()
    expect(db.insert).toHaveBeenCalledOnce()
    expect(mocks.compensation).toHaveBeenCalledTimes(2)
    expect(mocks.flush.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.compensation.mock.invocationCallOrder[1] ?? 0,
    )
  })
  it('rejects uncommitted deliveries and skips marked deliveries', async () => {
    const context = createBillingContext(env)
    db.results.push([{ id, status: 'failed' }])
    await expect(postprocessBillingDelivery(context, id)).rejects.toThrow('not committed')
    db.results.push([{ id, status: 'ignored' }], [{ id: 'marker' }])
    await postprocessBillingDelivery(context, id)
    expect(mocks.flush).not.toHaveBeenCalled()
  })
  it('bounds notification-gap recovery and records only successful postprocessing', async () => {
    db.results.push([{ id }], [{ id, status: 'processed' }], [])
    expect(await recoverBillingDeliveries(createBillingContext(env))).toEqual({ failures: [] })
    expect(db.query.limit).toHaveBeenCalledWith(100)
    expect(db.insert).toHaveBeenCalledOnce()
    const mail = mocks.flush.mock.calls[0]?.[0]
    await mail.queue.send({ v: 1 }, { contentType: 'json' })
    expect(env.EMAIL_QUEUE.send).toHaveBeenCalledWith({ v: 1 }, { contentType: 'json' })
  })
})

it('preserves P1 dispatcher schedules and routes both billing queues', async () => {
  const bindings = env as unknown as Cloudflare.Env
  await worker.scheduled({ cron: '*/5 * * * *' } as ScheduledController, bindings)
  expect(runDeletionCleanup).toHaveBeenCalledOnce()
  expect(runHeartbeat).toHaveBeenCalledOnce()
  await worker.scheduled({ cron: '0 3 * * *' } as ScheduledController, bindings)
  expect(runWorkspaceCleanup).toHaveBeenCalledOnce()
  await worker.scheduled({ cron: BILLING_HOURLY_CRON } as ScheduledController, bindings)
  expect(mocks.annual).toHaveBeenCalledOnce()
  for (const queue of ['events', 'events-staging']) {
    const entry = message({ v: 1, deliveryId: id })
    db.results.push([{ id, status: 'ignored' }], [{ id: 'marker' }])
    await worker.queue({ queue, messages: [entry] } as unknown as MessageBatch<unknown>, bindings)
    expect(entry.ack).toHaveBeenCalledOnce()
  }
})

it('reports failed compensation and still flushes durable notifications on the retry schedule', async () => {
  mocks.compensation.mockResolvedValueOnce({ claimed: 1, completed: 0, failed: 1 })
  await expect(runBillingSchedule(BILLING_RETRY_CRON, env)).rejects.toThrow('compensation (1)')
  expect(mocks.flush).toHaveBeenCalledOnce()
})

it('missing payment credentials keep both providers unavailable without remote requests', async () => {
  const billing = await vi.importActual<typeof import('@saas/billing')>('@saas/billing')
  const remote = vi.fn()
  const runtime = billing.createTestPaymentRuntime({}, ['stripe', 'paypal'], { fetch: remote })
  expect(runtime.providers).toEqual({})
  expect(runtime.readiness).toEqual([
    { id: 'stripe', available: false },
    { id: 'paypal', available: false },
  ])
  expect(remote).not.toHaveBeenCalled()
})
