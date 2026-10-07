import {
  type BillingProviders,
  type BillingQueueMessage,
  createBillingEventHandler,
  createCompensationFailureHandler,
  processWebhook,
  WebhookVerificationError,
} from '@saas/billing'
import type { Database, PaymentProviderId } from '@saas/db'
import { log, withRequestId } from '@saas/shared/log'
import { enqueueOperations } from '../notifications/operations.ts'

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
      ...createBillingEventHandler({
        db: options.db,
        providers: options.providers,
        subscriptionCreditGraceHours: options.subscriptionCreditGraceHours,
      }),
      onFailure: createCompensationFailureHandler(options.db),
      notify: async ({ delivery, events }) => {
        const operations = (events ?? []).flatMap((event) =>
          event.type === 'payment.succeeded'
            ? [
                {
                  event: 'payment.succeeded' as const,
                  sourceId: `${event.provider}:${event.payment.providerPaymentId}`,
                  ...(event.payment.metadata
                    ? { workspaceId: event.payment.metadata.workspaceId }
                    : {}),
                  amount: event.payment.amount,
                  currency: event.payment.currency,
                },
              ]
            : [],
        )
        try {
          await options.queue.send(
            withRequestId({
              v: 1,
              deliveryId: delivery.id,
              ...(operations.length ? { operations } : {}),
            }),
            { contentType: 'json' },
          )
        } catch (error) {
          log.warn('operations.enqueue_failed', { deliveryId: delivery.id })
          throw error // 保留原有管线的投递失败状态与恢复机制。
        }
      },
    })
    // DB failure must trigger platform retry. Queue failure is recovered from the durable row by Jobs.
    if (result.status === 'failed') {
      log.error('billing.webhook_failed', {
        provider: providerId,
        deliveryId: result.delivery?.id,
        error: result.error,
      })
      if (result.delivery)
        await enqueueOperations(options.queue, {
          event: 'webhook.failed',
          sourceId: `${result.delivery.id}:${result.delivery.attempts}`,
        })
      return new Response('Processing failed', { status: 500 })
    }
    log.info('billing.webhook_processed', {
      provider: providerId,
      deliveryId: result.delivery?.id,
      status: result.status,
      ...('notification' in result ? { notification: result.notification?.status } : {}),
    })
    return Response.json({ received: true })
  } catch (error) {
    if (error instanceof WebhookVerificationError)
      log.warn('billing.webhook_rejected', { provider: providerId, error })
    else log.error('billing.webhook_failed', { provider: providerId, error })
    return new Response(
      error instanceof WebhookVerificationError ? 'Invalid signature' : 'Processing failed',
      { status: error instanceof WebhookVerificationError ? 400 : 500 },
    )
  }
}
