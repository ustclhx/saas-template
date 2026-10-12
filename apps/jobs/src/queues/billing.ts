import { parseBillingQueueMessage } from '@saas/billing'
import type { Database } from '@saas/db'
import type { QueueBatch } from '@saas/platform'
import { log, newRequestId, withLogContext } from '@saas/shared/log'
import { type BillingEnv, createBillingContext, postprocessBillingDelivery } from '../billing.ts'
import { deliverOperations, parseOperationsMessage } from '../notifications/operations.ts'
import { type JobObserver, logJobObserver } from '../observer.ts'

export async function handleBillingBatch(
  batch: QueueBatch<unknown>,
  env: BillingEnv,
  observer: JobObserver = logJobObserver,
) {
  // Invalid messages never initialize a provider or touch the database.
  let context: ReturnType<typeof createBillingContext> | undefined
  let operationsDb: Database | undefined
  for (const message of batch.messages) {
    const body = parseBillingQueueMessage(message.body)
    const operations = parseOperationsMessage(message.body)
    if (!body && !operations) {
      log.warn('billing.invalid', { id: message.id })
      message.ack()
      continue
    }
    // Restore the enqueuing request's ID; messages enqueued before it existed get a fresh one.
    await withLogContext(
      { requestId: body?.requestId ?? operations?.requestId ?? newRequestId() },
      async () => {
        // 计费后处理与运营通知分别确认 / 重试：运营推送失败不会让计费后处理重跑，反之亦然。
        try {
          if (body) {
            context ??= createBillingContext(env)
            await postprocessBillingDelivery(context, body.deliveryId)
            log.info('billing.postprocessed', { id: message.id, deliveryId: body.deliveryId })
          } else if (operations) {
            operationsDb ??= env.db.business()
            for (const event of operations.operations) await deliverOperations(operationsDb, event)
            log.info('operations.delivered', { id: message.id })
          }
          message.ack()
        } catch (error) {
          observer.captureException(error)
          log.warn(body ? 'billing.retry' : 'operations.retry', {
            id: message.id,
            attempts: message.attempts,
            error,
          })
          message.retry({
            delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 900),
          })
        }
      },
    )
  }
}
