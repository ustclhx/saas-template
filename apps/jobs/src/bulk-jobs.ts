// 批量删除 / 群发任务的统一执行与上报（openspec add-ops-safeguards D1–D3）。
// 任务实现（各 package）只返回 BulkJobOutcome；日志、运维告警与去重集中在这里。

import type { QueueProducer } from '@saas/platform'
import type { BulkJobDefinition, BulkJobOutcome, BulkJobTrip } from '@saas/shared/bulk-job'
import { utcDay } from '@saas/shared/bulk-job'
import { log, withRequestId } from '@saas/shared/log'
import type { OperationsEvent } from './notifications/operations.ts'

export const BULK_JOB_GUARD_EVENT = 'ops.bulk_job.guard_tripped'

/** 任务返回值中携带的防护结果；没有防护结果的任务（kind: 'none'）不上报 */
export type WithGuard = { readonly guard?: BulkJobOutcome }

/** 运维通知只经事件队列投递；队列不可用时记日志，不让告警失败掩盖任务本身的结果 */
export async function enqueueOperations(
  eventsQueue: QueueProducer<unknown> | undefined,
  operations: readonly OperationsEvent[],
) {
  if (!operations.length) return
  try {
    if (!eventsQueue) throw new Error('Events queue unavailable')
    await eventsQueue.send(withRequestId({ v: 1, operations }))
  } catch {
    log.warn('operations.enqueue_failed', { event: operations[0]?.event, count: operations.length })
  }
}

/** 告警按「任务 + 原因 + UTC 日」去重：重复运行或重放产生相同 sourceId，由运维通知消费者跳过 */
export function guardTrippedEvent(job: string, trip: BulkJobTrip, now = new Date()) {
  return {
    event: BULK_JOB_GUARD_EVENT,
    sourceId: `bulk_job:${job}:${trip.reason}:${utcDay(now)}`,
    ...(trip.count !== undefined && { count: trip.count }),
  } satisfies OperationsEvent
}

/** 记录到达上限与防护触发；告警只含任务标识、原因与计数 */
export async function reportBulkJob(
  job: string,
  outcome: BulkJobOutcome | undefined,
  eventsQueue: QueueProducer<unknown> | undefined,
  now = new Date(),
) {
  if (!outcome) return
  if (outcome.capReached) log.warn('job.cap_reached', { job, processed: outcome.processed })
  for (const trip of outcome.tripped)
    log.error('job.guard_tripped', {
      job,
      reason: trip.reason,
      ...(trip.count !== undefined && { count: trip.count }),
    })
  await enqueueOperations(
    eventsQueue,
    outcome.tripped.map((trip) => guardTrippedEvent(job, trip, now)),
  )
}

/** 执行一个已声明的任务并上报其防护结果；任务自身的异常照常抛出 */
// biome-ignore lint/suspicious/noConfusingVoidType: 插件任务沿用 Promise<void> 写法。
export async function runBulkJob<Context, Result extends WithGuard | undefined | void>(
  definition: BulkJobDefinition<Context, Result>,
  context: Context,
  eventsQueue: QueueProducer<unknown> | undefined,
): Promise<Result> {
  const result = await definition.run(context)
  if (definition.safety.kind !== 'none')
    await reportBulkJob(definition.id, result ? result.guard : undefined, eventsQueue)
  return result
}
