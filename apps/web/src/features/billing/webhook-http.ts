import {
  type BillingProviders,
  type BillingQueueMessage,
  createBillingEventHandler,
  createCompensationFailureHandler,
  processWebhook,
  WebhookVerificationError,
} from '@saas/billing'
import type { Database, PaymentProviderId } from '@saas/db'

export async function handleBillingWebhook(
  request: Request,
  providerId: string,
  options: {
    db: Database
    subscriptionCreditGraceHours: number
    providers: BillingProviders
    queue: {
      send(message: BillingQueueMessage, options: { contentType: 'json' }): Promise<unknown>
    }
  },
) {
  if (providerId !== 'stripe' && providerId !== 'paypal')
    return new Response('Not Found', { status: 404 })
  const provider = options.providers[providerId as PaymentProviderId]
  if (!provider) return new Response('Payments unavailable', { status: 503 })
  const rawBody = await request.text()
  if (new TextEncoder().encode(rawBody).length > 1_048_576)
    return new Response('Payload too large', { status: 413 })
  try {
    JSON.parse(rawBody)
  } catch {
    return new Response('Invalid payload', { status: 400 })
  }
  try {
    const result = await processWebhook({
      db: options.db,
      provider,
      request,
      rawBody,
      ...createBillingEventHandler({ db: options.db, providers: options.providers }),
      onFailure: createCompensationFailureHandler(options.db),
      notify: async ({ delivery }) => {
        await options.queue.send({ v: 1, deliveryId: delivery.id }, { contentType: 'json' })
      },
    })
    // DB failure must trigger platform retry. Queue failure is recovered from the durable row by Jobs.
    if (result.status === 'failed') return new Response('Processing failed', { status: 500 })
    return Response.json({ received: true })
  } catch (error) {
    return new Response(
      error instanceof WebhookVerificationError ? 'Invalid signature' : 'Processing failed',
      { status: error instanceof WebhookVerificationError ? 400 : 500 },
    )
  }
}
