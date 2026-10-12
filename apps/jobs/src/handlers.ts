import type { EmailTransportConfig } from '@saas/config'
import type {
  Capability,
  DeadLetterSink,
  QueueBatch,
  ScheduledHandler,
  Scheduler,
} from '@saas/platform'
import { newRequestId, withLogContext } from '@saas/shared/log'
import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  type BillingEnv,
  type BillingScheduleFeatures,
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
  eventsDeadLetters?: DeadLetterSink<unknown>
  billingEnabled?: boolean
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
    return handleBillingBatch(batch, context, context.observer, {
      ...(context.eventsDeadLetters && { deadLetters: context.eventsDeadLetters }),
      ...(context.billingEnabled !== undefined && { billingEnabled: context.billingEnabled }),
    })
  }
  throw new Error(`Unknown queue: ${batch.queue}`)
}

/** B 的真实 scheduler 接入点；保持五条 UTC trigger 和原有分组失败语义。 */
export interface JobsScheduleOptions {
  features?: BillingScheduleFeatures
  skipUnavailableFiles?: boolean
  heartbeat?: ScheduledHandler
}

export function registerJobsSchedules(
  scheduler: Scheduler,
  context: JobsContext,
  options: JobsScheduleOptions = {},
) {
  for (const [id, cron] of [
    ['jobs-heartbeat-v1', HEARTBEAT_CRON],
    ['jobs-daily-maintenance-v1', WORKSPACE_CLEANUP_CRON],
    ['jobs-billing-hourly-v1', BILLING_HOURLY_CRON],
    ['jobs-ten-minute-maintenance-v1', BILLING_RETRY_CRON],
    ['jobs-billing-daily-v1', BILLING_DAILY_CRON],
  ] as const) {
    scheduler.register({ id, cron, timeZone: 'UTC', missedRun: 'skip' }, ({ scheduledAt }) =>
      withLogContext({ requestId: newRequestId(), cron }, () =>
        runJobsSchedule(cron, scheduledAt, context, options),
      ),
    )
  }
}

export async function runJobsSchedule(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions = {},
) {
  context.observer.tagContext()
  const billingEnabled = !options.features || options.features.billing || options.features.credits
  switch (cron) {
    case BILLING_HOURLY_CRON:
    case BILLING_DAILY_CRON:
      if (billingEnabled) return runBillingSchedule(cron, context, options.features)
      return
    case BILLING_RETRY_CRON: {
      // 文件清理与计费补偿独立执行；任何一项失败仍将本次 Cron 标记为失败。
      const results = await Promise.allSettled([
        ...(billingEnabled ? [runBillingSchedule(cron, context, options.features)] : []),
        ...(options.skipUnavailableFiles && !context.files.available
          ? []
          : [runFilesCleanup(context)]),
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
      if (options.heartbeat) return options.heartbeat({ scheduledAt })
      await runDeletionCleanup(context)
      return runHeartbeat(context)
    default:
      throw new Error(`Unknown cron: ${cron}`)
  }
}
