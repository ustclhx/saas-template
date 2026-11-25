import type { AiFaultInjectionEnv } from '@saas/config'
import type { EmailSender } from '@saas/email'
import type {
  Capability,
  DeadLetterSink,
  KeyValueStore,
  QueueBatch,
  ScheduledHandler,
  Scheduler,
} from '@saas/platform'
import {
  type JobObserver,
  log,
  newRequestId,
  withJobObserver,
  withLogContext,
} from '@saas/shared/log'
import type { ShareCardObjects } from '@saas/storage'
import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  type BillingEnv,
  type BillingScheduleFeatures,
  runBillingSchedule,
} from './billing.ts'
import { CORE_TASK_GROUP_JOBS, type CoreJobId } from './bulk-job-registry.ts'
import { runBulkJob } from './bulk-jobs.ts'
import { runAdminConfirmationsCleanup } from './cron/admin-confirmations-cleanup.ts'
import { runDeletionCleanup } from './cron/deletion-cleanup.ts'
import { runFilesCleanup } from './cron/files-cleanup.ts'
import { HEARTBEAT_CRON, runHeartbeat } from './cron/heartbeat.ts'
import { runMetricsDaily } from './cron/metrics-daily.ts'
import { runWorkspaceCleanup, WORKSPACE_CLEANUP_CRON } from './cron/workspace-cleanup.ts'
import type { JobsPluginModule, PluginCronGroup } from './plugins/module.ts'
import { pluginCronTasks, pluginQueueHandler } from './plugins/register.ts'
import { handleBillingBatch } from './queues/billing.ts'
import { handleEmailBatch, type JobsEmailTransport } from './queues/email.ts'
import { handleEventsDeadLetterBatch } from './queues/events-dead-letter.ts'

export interface JobsContext extends BillingEnv {
  config: BillingEnv['config'] & AiFaultInjectionEnv
  emailTransport: JobsEmailTransport
  emailSender?: EmailSender
  files: Capability<{ delete(key: string | string[]): Promise<void> }>
  shareCardCache?: KeyValueStore
  shareCards?: ShareCardObjects
  observer: JobObserver
  emailDeadLetters?: DeadLetterSink<unknown>
  eventsDeadLetters?: DeadLetterSink<unknown>
  billingEnabled?: boolean
  /** 启用插件的 jobs 入口（各目标入口从生成文件传入）：队列消费者与挂在已有触发器上的定时任务 */
  plugins?: readonly JobsPluginModule[]
}

const EMAIL_QUEUES = new Set(['email', 'email-staging', 'email-production'])
const EVENTS_QUEUES = new Set(['events', 'events-staging', 'events-production'])

export function consumeJobsBatch(batch: QueueBatch<unknown>, context: JobsContext) {
  return withJobObserver(context.observer, () => consumeBatch(batch, context))
}

async function consumeBatch(batch: QueueBatch<unknown>, context: JobsContext) {
  context.observer.tagContext()
  if (EMAIL_QUEUES.has(batch.queue)) {
    return handleEmailBatch(batch, context.emailTransport, {
      observer: context.observer,
      ...(context.emailSender && { sender: context.emailSender }),
      ...(context.emailDeadLetters && { deadLetters: context.emailDeadLetters }),
    })
  }
  if (['events-dlq', 'events-dlq-staging', 'events-dlq-production'].includes(batch.queue)) {
    return handleEventsDeadLetterBatch(batch, context.db.business())
  }
  if (EVENTS_QUEUES.has(batch.queue)) {
    return handleBillingBatch(batch, context, context.observer, {
      ...(context.eventsDeadLetters && { deadLetters: context.eventsDeadLetters }),
      ...(context.billingEnabled !== undefined && { billingEnabled: context.billingEnabled }),
    })
  }
  const plugin = pluginQueueHandler(context.plugins, batch.queue)
  if (plugin) return plugin.handle(batch, context)
  throw new Error(`Unknown queue: ${batch.queue}`)
}

/** B 的真实 scheduler 接入点；保持五条 UTC trigger 和原有分组失败语义。 */
export interface JobsScheduleOptions {
  /** 仅 Cloudflare staging 入口设置 reduced；Node 保持默认五条调度。 */
  cronProfile?: string
  features?: BillingScheduleFeatures
  skipUnavailableFiles?: boolean
  heartbeat?: ScheduledHandler
}

// 触发器映射到原有逻辑任务组；降低 staging 唤醒频率不改变任务组内部语义。
export const CRON_TASK_GROUPS = {
  default: new Map<string, readonly [string, ...string[]]>([
    [HEARTBEAT_CRON, [HEARTBEAT_CRON]],
    [WORKSPACE_CLEANUP_CRON, [WORKSPACE_CLEANUP_CRON]],
    [BILLING_HOURLY_CRON, [BILLING_HOURLY_CRON]],
    [BILLING_RETRY_CRON, [BILLING_RETRY_CRON]],
    [BILLING_DAILY_CRON, [BILLING_DAILY_CRON]],
  ]),
  reduced: new Map<string, readonly [string, ...string[]]>([
    ['*/30 * * * *', [HEARTBEAT_CRON, BILLING_RETRY_CRON]],
    [WORKSPACE_CLEANUP_CRON, [WORKSPACE_CLEANUP_CRON]],
    [BILLING_HOURLY_CRON, [BILLING_HOURLY_CRON]],
    [BILLING_DAILY_CRON, [BILLING_DAILY_CRON]],
  ]),
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
    if (
      options.features &&
      !options.features.billing &&
      !options.features.credits &&
      (cron === BILLING_HOURLY_CRON || cron === BILLING_DAILY_CRON)
    )
      continue
    scheduler.register({ id, cron, timeZone: 'UTC', missedRun: 'skip' }, ({ scheduledAt }) =>
      withLogContext({ requestId: newRequestId(), cron }, () =>
        runJobsSchedule(cron, scheduledAt, context, options),
      ),
    )
  }
}

export function runJobsSchedule(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions = {},
) {
  return withJobObserver(context.observer, () => runSchedule(cron, scheduledAt, context, options))
}

async function runSchedule(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions,
) {
  context.observer.tagContext()
  const profile = options.cronProfile ?? 'default'
  if (profile !== 'default' && profile !== 'reduced') {
    log.error('cron.unknown_profile', { profile, cron })
    throw new Error(`Unknown cron profile: ${profile}`)
  }
  const groups = CRON_TASK_GROUPS[profile].get(cron)
  if (!groups) {
    log.error('cron.unknown_trigger', { profile, cron })
    throw new Error(`Unknown cron: ${cron}`)
  }
  if (groups.length === 1) return runJobsTaskGroup(groups[0], scheduledAt, context, options)
  // 心跳与维护独立执行，任一组失败仍等待其他组完成，并将本次触发记为失败。
  const results = await Promise.allSettled(
    groups.map((group) => runJobsTaskGroup(group, scheduledAt, context, options)),
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      'Reduced maintenance cron failed',
    )
}

/** 插件定时任务所挂的触发器 */
export const PLUGIN_CRON_GROUPS = new Map<string, PluginCronGroup>([
  [HEARTBEAT_CRON, 'heartbeat'],
  [BILLING_RETRY_CRON, 'ten-minute'],
  [WORKSPACE_CLEANUP_CRON, 'daily'],
])

/** 核心任务组与同组插件任务并行执行；任一失败仍等待其余完成，并让本次触发记为失败 */
async function runJobsTaskGroup(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions,
) {
  const group = PLUGIN_CRON_GROUPS.get(cron)
  const tasks = group ? pluginCronTasks(context.plugins, group) : []
  if (tasks.length === 0) return runCoreTaskGroup(cron, scheduledAt, context, options)
  const results = await Promise.allSettled([
    runCoreTaskGroup(cron, scheduledAt, context, options),
    ...tasks.map((task) =>
      withLogContext({ pluginTask: task.id }, () =>
        runBulkJob(
          { id: task.id, safety: task.safety, run: () => task.run(context, scheduledAt) },
          undefined,
          context.eventsQueue,
        ),
      ),
    ),
  ])
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      `Cron ${cron} with plugin tasks failed`,
    )
}

interface CoreRun {
  cron: string
  scheduledAt: Date
  context: JobsContext
  options: JobsScheduleOptions
}

/** 每个登记的核心任务都必须有执行入口（类型保证与 bulk-job-registry.ts 的 CORE_JOBS 一一对应） */
const CORE_RUNNERS: Record<CoreJobId, (run: CoreRun) => Promise<unknown>> = {
  'deletion-cleanup': ({ context }) => runDeletionCleanup(context),
  heartbeat: ({ context }) => runHeartbeat(context),
  billing: async ({ cron, context, options }) => {
    const enabled = !options.features || options.features.billing || options.features.credits
    if (enabled) return runBillingSchedule(cron, context, options.features)
  },
  'files-cleanup': async ({ context, options }) => {
    if (options.skipUnavailableFiles && !context.files.available) return
    return runFilesCleanup(context)
  },
  'workspace-maintenance': ({ context }) => runWorkspaceCleanup(context),
  'admin-confirmations-cleanup': ({ context }) => runAdminConfirmationsCleanup(context),
  'metrics-daily': ({ context, scheduledAt }) => runMetricsDaily(context, scheduledAt.getTime()),
}

/** 多任务组：组内任务独立执行，任一失败仍等待其余完成，并让本次 Cron 标记为失败 */
const PARALLEL_GROUP_ERRORS: Readonly<Record<string, string>> = {
  [BILLING_RETRY_CRON]: 'Ten-minute maintenance cron failed',
  // METRICS_DAILY_CRON 与 WORKSPACE_CLEANUP_CRON 是同一个触发器
  [WORKSPACE_CLEANUP_CRON]: 'Daily maintenance cron failed',
}

async function runCoreTaskGroup(
  cron: string,
  scheduledAt: Date,
  context: JobsContext,
  options: JobsScheduleOptions,
) {
  const jobs = CORE_TASK_GROUP_JOBS[cron]
  if (!jobs) throw new Error(`Unknown cron: ${cron}`)
  const run: CoreRun = { cron, scheduledAt, context, options }
  if (cron === HEARTBEAT_CRON) {
    // Node 以自己的心跳实现（含凭据清理）替换整组
    if (options.heartbeat) return options.heartbeat({ scheduledAt })
    // 凭据清理失败时不记录心跳，与原有语义一致
    for (const job of jobs) await CORE_RUNNERS[job](run)
    return
  }
  const [single] = jobs
  if (jobs.length === 1 && single) {
    await CORE_RUNNERS[single](run)
    return
  }
  const results = await Promise.allSettled(jobs.map((job) => CORE_RUNNERS[job](run)))
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      PARALLEL_GROUP_ERRORS[cron] ?? `Cron ${cron} failed`,
    )
}
