import type { BillingProviders, WebhookResult } from '@saas/billing'
import type { Database } from '@saas/db'
import { beforeEach, expect, it, vi } from 'vitest'

const process = vi.hoisted(() => vi.fn())
vi.mock('@saas/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@saas/billing')>()
  return {
    ...actual,
    processWebhook: process,
    createBillingEventHandler: () => ({}),
    createCompensationFailureHandler: () => vi.fn(),
  }
})

import { WebhookVerificationError } from '@saas/billing'
import { handleBillingWebhook } from './webhook-http.ts'

const options = {
  db: {} as Database,
  subscriptionCreditGraceHours: 24,
  providers: { stripe: { id: 'stripe' } } as BillingProviders,
  queue: { send: vi.fn() },
}
const request = () =>
  new Request('https://example.test/api/billing/webhooks/stripe', {
    method: 'POST',
    body: '{"id":"fixture"}',
  })
beforeEach(() => process.mockReset())
it('does not acknowledge unavailable providers or malformed deliveries', async () => {
  expect(
    (await handleBillingWebhook(request(), 'stripe', { ...options, providers: {} })).status,
  ).toBe(503)
  expect(
    (
      await handleBillingWebhook(
        new Request('https://example.test', { method: 'POST', body: 'invalid' }),
        'stripe',
        options,
      )
    ).status,
  ).toBe(400)
  expect(process).not.toHaveBeenCalled()
})
it('rejects invalid signatures but keeps transport and business failure retryable', async () => {
  process.mockRejectedValueOnce(new WebhookVerificationError('invalid'))
  expect((await handleBillingWebhook(request(), 'stripe', options)).status).toBe(400)
  process.mockRejectedValueOnce(new Error('temporary remote failure'))
  expect((await handleBillingWebhook(request(), 'stripe', options)).status).toBe(500)
  process.mockResolvedValueOnce({ status: 'failed' } as WebhookResult)
  expect((await handleBillingWebhook(request(), 'stripe', options)).status).toBe(500)
})
it('acknowledges committed payments even when post-commit queue delivery needs recovery', async () => {
  process.mockResolvedValueOnce({
    status: 'processed',
    notification: { status: 'failed', error: 'queue' },
  } as WebhookResult)
  const response = await handleBillingWebhook(request(), 'stripe', options)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ received: true })
})
