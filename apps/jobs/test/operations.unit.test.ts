import { afterEach, expect, it, vi } from 'vitest'
import { parseOperationsMessage, sendOperationsChannel } from '../src/notifications/operations.ts'

afterEach(() => vi.restoreAllMocks())
it('accepts all four event types but rejects malformed envelopes and drops unrecognized private fields', () => {
  for (const event of [
    'payment.succeeded',
    'refund.requested',
    'webhook.failed',
    'reconciliation.failed',
  ]) {
    expect(
      parseOperationsMessage({
        v: 1,
        requestId: 'req-1',
        operations: [{ event, sourceId: 'id-1', token: 'private' }],
      }),
    ).toEqual({ requestId: 'req-1', operations: [{ event, sourceId: 'id-1' }] })
  }
  expect(parseOperationsMessage({ v: 1, deliveryId: 'old-message' })).toBeNull()
  expect(
    parseOperationsMessage({ v: 1, operations: [{ event: 'unknown', sourceId: '1' }] }),
  ).toBeNull()
  expect(
    parseOperationsMessage({
      v: 1,
      operations: [{ event: 'payment.succeeded', sourceId: '1', amount: -1 }],
    }),
  ).toBeNull()
})
it('treats Telegram API rejection and Discord HTTP failure as retryable without exposing endpoint secrets', async () => {
  const channels = {
    telegramBotToken: 'private-token',
    telegramChatId: '-1',
    discordWebhookUrl: 'https://discord.com/api/webhooks/1/private-webhook',
  }
  const event = { event: 'webhook.failed' as const, sourceId: 'delivery-1' }
  const http = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ ok: false }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  await expect(sendOperationsChannel('telegram', channels, event)).rejects.toThrow(
    'Operations telegram delivery failed',
  )
  await expect(sendOperationsChannel('discord', channels, event)).rejects.toThrow(
    'Operations discord delivery failed',
  )
  expect(http.mock.calls[1]?.[0]).toBe(`${channels.discordWebhookUrl}?wait=true`)
})
