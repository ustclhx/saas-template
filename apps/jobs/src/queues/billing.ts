import { type BillingEnv, createBillingContext, postprocessBillingDelivery } from '../billing.ts'

// Temporary local envelope until the shared billing contract is exported.
export type BillingQueueMessage = { v: 1; deliveryId: string }
export function parseBillingQueueMessage(value: unknown): BillingQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (
    message.v !== 1 ||
    typeof message.deliveryId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      message.deliveryId,
    )
  )
    return null
  return { v: 1, deliveryId: message.deliveryId }
}

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
