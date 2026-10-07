import { parseBillingQueueMessage } from '@saas/billing'
import { log, newRequestId, withLogContext } from '@saas/shared/log'
import { type BillingEnv, createBillingContext, postprocessBillingDelivery } from '../billing.ts'

export async function handleBillingBatch(batch: MessageBatch<unknown>, env: BillingEnv) {
  // Invalid messages never initialize a provider or touch the database.
  let context: ReturnType<typeof createBillingContext> | undefined
  for (const message of batch.messages) {
    const body = parseBillingQueueMessage(message.body)
    if (!body) {
      log.warn('billing.invalid', { id: message.id })
      message.ack()
      continue
    }
    // Restore the enqueuing request's ID; messages enqueued before it existed get a fresh one.
    await withLogContext({ requestId: body.requestId ?? newRequestId() }, async () => {
      try {
        context ??= createBillingContext(env)
        await postprocessBillingDelivery(context, body.deliveryId)
        log.info('billing.postprocessed', { id: message.id, deliveryId: body.deliveryId })
        message.ack()
      } catch (error) {
        log.warn('billing.retry', { id: message.id, attempts: message.attempts, error })
        message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 900) })
      }
    })
  }
}
