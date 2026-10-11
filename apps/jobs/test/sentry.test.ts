import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

it('captures an unhandled staging Cron error with release and request ID through the real SDK', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
  const ctx = createExecutionContext()
  await expect(
    worker.scheduled(
      createScheduledController({ cron: 'unknown-fixture-cron' }),
      {
        ...env,
        SENTRY_DSN: 'https://fixture@example.test/1',
        SENTRY_ENVIRONMENT: 'staging',
        APP_VERSION: 'fixture-commit-sha',
      },
      ctx,
    ),
  ).rejects.toThrow('Unknown cron')
  await waitOnExecutionContext(ctx)
  const bodies = send.mock.calls.map(([, init]) => String(init?.body)).join('\n')
  const event = bodies
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.exception)
  expect(event).toMatchObject({
    release: 'fixture-commit-sha',
    environment: 'staging',
    tags: { requestId: expect.any(String) },
  })
})

it('does not initialize or send from the local handler even when a DSN is present', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'))
  const ctx = createExecutionContext()
  await expect(
    worker.scheduled(
      createScheduledController({ cron: 'unknown-fixture-cron' }),
      {
        ...env,
        SENTRY_DSN: 'https://fixture@example.test/1',
        SENTRY_ENVIRONMENT: 'development',
      },
      ctx,
    ),
  ).rejects.toThrow('Unknown cron')
  await waitOnExecutionContext(ctx)
  expect(send).not.toHaveBeenCalled()
})
