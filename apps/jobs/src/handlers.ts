import type { EmailTransportConfig } from '@saas/config'
import type { Capability, DeadLetterSink, QueueBatch, Scheduler } from '@saas/platform'
import { newRequestId, withLogContext } from '@saas/shared/log'
import './ai.ts'
import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  type BillingEnv,
  runBillingSchedule,
} from './billing.ts'
import { runDeletionCleanup } from './cron/deletion-cleanup.ts'
import { runFilesCleanup } from './cron/files-cleanup.ts'
import { HEARTBEAT_CRON, runHeartbeat } from './cron/heartbeat.ts'
import { runMetricsDaily } from './cron/metrics-daily.ts'
import { runWorkspaceCleanup, WORKSPACE_CLEANUP_CRON } from './cron/workspace-cleanup.ts'
import type { JobObserver } from './observer.ts'
import { handleBillingBatch } from './queues/billing.ts'
import { handleEmailBatch } from './queues/email.ts'

export interface JobsContext extends BillingEnv {
  emailTransport: EmailTransportConfig
  files: Capability<{ delete(key: string | string[]): Promise<void> }>
  observer: JobObserver
  emailDeadLetters?: DeadLetterSink<unknown>
}

const EMAIL_QUEUES = new Set(['email', 'email-staging'])
const EVENTS_QUEUES = new Set(['events', 'events-staging'])

export async function consumeJobsBatch(batch: QueueBatch<unknown>, context: JobsContext) {
  context.observer.tagContext()
  if (EMAIL_QUEUES.has(batch.queue)) {
    return handleEmailBatch(batch, context.emailTransport, {
      observer: context.observer,
      ...(context.emailDeadLetters && { deadLetters: context.emailDeadLetters }),
    })
  }
  if (EVENTS_QUEUES.has(batch.queue)) {
    return handleBillingBatch(batch, context, context.observer)
  }
  throw new Error(`Unknown queue: ${batch.queue}`)
}

/** B 的真实 scheduler 接入点；保持五条 UTC trigger 和原有分组失败语义。 */
export function registerJobsSchedules(scheduler: Scheduler, context: JobsContext) {
  for (const cron of [
    HEARTBEAT_CRON,
    WORKSPACE_CLEANUP_CRON,
    BILLING_HOURLY_CRON,
    BILLING_RETRY_CRON,
    BILLING_DAILY_CRON,
  ]) {
    scheduler.register(
      { id: `jobs:${cron}`, cron, timeZone: 'UTC', missedRun: 'skip' },
      ({ scheduledAt }) =>
        withLogContext({ requestId: newRequestId(), cron }, () =>
          runJobsSchedule(cron, scheduledAt, context),
        ),
    )
  }
}

export async function runJobsSchedule(cron: string, scheduledAt: Date, context: JobsContext) {
  context.observer.tagContext()
  switch (cron) {
    case BILLING_HOURLY_CRON:
    case BILLING_DAILY_CRON:
      return runBillingSchedule(cron, context)
    case BILLING_RETRY_CRON: {
      // 文件清理与计费补偿独立执行；任何一项失败仍将本次 Cron 标记为失败。
      const results = await Promise.allSettled([
        runBillingSchedule(cron, context),
        runFilesCleanup(context),
      ])
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Ten-minute maintenance cron failed',
        )
      return
    }
    // METRICS_DAILY_CRON 与 WORKSPACE_CLEANUP_CRON 是同一个触发器：两项任务独立执行，
    // 任一失败不影响另一项，但仍让本次 Cron 标记为失败。
    case WORKSPACE_CLEANUP_CRON: {
      const results = await Promise.allSettled([
        runWorkspaceCleanup(context),
        runMetricsDaily(context, scheduledAt.getTime()),
      ])
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Daily maintenance cron failed',
        )
      return
    }
    case HEARTBEAT_CRON:
      await runDeletionCleanup(context)
      return runHeartbeat(context)
    default:
      throw new Error(`Unknown cron: ${cron}`)
  }
}
