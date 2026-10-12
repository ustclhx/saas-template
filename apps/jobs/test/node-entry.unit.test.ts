import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { nodeEnvSchema } from '@saas/config/node'
import { afterEach, expect, it, vi } from 'vitest'
import { startNodeJobs } from '../src/node/runtime.ts'

const resources = vi.hoisted(() => ({
  closeDb: vi.fn(async () => {}),
  closeCache: vi.fn(async () => {}),
  createCache: vi.fn(),
  createDb: vi.fn(),
}))
vi.mock('@saas/db', () => ({
  createDb: resources.createDb.mockImplementation(() => ({ close: resources.closeDb })),
}))
vi.mock('@saas/platform/node', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNodeCache: resources.createCache.mockImplementation(async () => ({
    close: resources.closeCache,
  })),
}))
const config = nodeEnvSchema.parse({
  DATABASE_URL: 'postgres://fixture@localhost/jobs',
  VALKEY_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'jobs-fixture-secret-at-least-32-characters',
  APP_URL: 'https://example.com',
  DB_POOL_MAX: 3,
  SHUTDOWN_TIMEOUT_MS: 100,
})
let active: Awaited<ReturnType<typeof startNodeJobs>> | undefined
afterEach(async () => {
  await active?.shutdown()
  active = undefined
  vi.clearAllMocks()
})

it('keeps liveness available with unconfigured task engines and drains before closing resources', async () => {
  active = await startNodeJobs(config, { host: '127.0.0.1', port: 0 })
  const port = (active.server.address() as AddressInfo).port
  const response = await fetch(`http://127.0.0.1:${port}/internal/live`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    status: 'ok',
    queue: { status: 'unavailable' },
    scheduler: { status: 'unavailable', lastCronAt: null },
  })
  expect(resources.createDb).toHaveBeenCalledWith(config.DATABASE_URL, { max: 3 })
  let finish!: () => void
  active.background.waitUntil(
    new Promise<void>((resolve) => {
      finish = resolve
    }),
  )
  const stopped = once(active.server, 'close')
  const shutdown = active.shutdown()
  expect(active.shutdown()).toBe(shutdown)
  await stopped
  expect(resources.closeCache).not.toHaveBeenCalled()
  expect(resources.closeDb).not.toHaveBeenCalled()
  finish()
  expect(await shutdown).toMatchObject({ completed: true, resourcesClosed: true })
  expect(resources.closeCache).toHaveBeenCalledOnce()
  expect(resources.closeDb).toHaveBeenCalledOnce()
})

it('reports incomplete shutdown and releases resources after the deadline', async () => {
  active = await startNodeJobs(config, { host: '127.0.0.1', port: 0 })
  active.background.waitUntil(new Promise(() => {}))
  expect(await active.shutdown()).toMatchObject({ completed: false, pendingTasks: 1 })
  expect(active.server.listening).toBe(false)
  expect(resources.closeCache).toHaveBeenCalledOnce()
  expect(resources.closeDb).toHaveBeenCalledOnce()
})
