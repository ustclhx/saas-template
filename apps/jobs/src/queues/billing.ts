import { parseBillingQueueMessage } from '@saas/billing'
import { type BillingEnv, createBillingContext, postprocessBillingDelivery } from '../billing.ts'

export async function handleBillingBatch(batch: MessageBatch<unknown>, env: BillingEnv) {
  // Invalid messages never initialize a provider or touch the database.
  let context: ReturnType<typeof createBillingContext> | undefined
  for (const message of batch.messages) {
    const body = parseBillingQueueMessage(message.body)
    if (!body) {
      console.warn(JSON.stringify({ event: 'billing.invalid', id: message.id }))
      message.ack()
      continue
    }
    try {
      context ??= createBillingContext(env)
      await postprocessBillingDelivery(context, body.deliveryId)
      message.ack()
    } catch {
      console.warn(
        JSON.stringify({ event: 'billing.retry', id: message.id, attempts: message.attempts }),
      )
      message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 900) })
    }
  }
}
