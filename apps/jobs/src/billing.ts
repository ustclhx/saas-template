// biome-ignore-all lint/plugin: Cross-workspace system audit markers have no workspace owner.
import {
  COMPENSATION_LIMIT,
  CREDIT_EXPIRATION_CAP,
  type CronFailure,
  clearResolvedRefundContacts,
  createPaymentRuntime,
  flushRefundNotifications,
  HOLD_SWEEP_CAP,
  type PaymentRuntimeEnv,
  REFUND_CONTACT_CLEANUP_CAP,
  REFUND_NOTIFICATION_LIMIT,
  runAnnualGrants,
  runCreditExpiration,
  runCreditReconciliation,
  runHoldSweep,
  runPendingCompensations,
  runSubscriptionReconciliation,
  SUBSCRIPTION_CANCEL_CAP,
} from '@saas/billing'
import { plausibleSite } from '@saas/config'
import { auditLog, type Database, webhookEvent } from '@saas/db'
import type { EmailQueueMessage } from '@saas/email/queue'
import type { DatabaseAccess, KeyValueStore, QueueProducer } from '@saas/platform'
import { type BulkJobDefinition, defineBulkJob, utcDay } from '@saas/shared/bulk-job'
import { log } from '@saas/shared/log'
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'
import templateConfig from '../../../template.config.ts'
import { enqueueOperations, runBulkJob, type WithGuard } from './bulk-jobs.ts'
import type { ServerAnalyticsTarget } from './notifications/analytics.ts'

export const BILLING_HOURLY_CRON = '0 * * * *'
export const BILLING_RETRY_CRON = '*/10 * * * *'
export const BILLING_DAILY_CRON = '0 4 * * *'
export const BILLING_POSTPROCESS_ACTION = 'billing.webhook_postprocessed'
export const BILLING_RECOVERY_LIMIT = 100
export interface BillingEnv {
  config: Readonly<PaymentRuntimeEnv>
  db: DatabaseAccess
  cache: KeyValueStore
  emailQueue: QueueProducer<EmailQueueMessage>
  eventsQueue?: QueueProducer<unknown>
  /** 服务端埋点目标；未配置时事件被确认丢弃，付款真相仍在数据库 */
  analytics?: ServerAnalyticsTarget | null
}

/** Cloudflare 与 Node 入口共用：模板关闭、未配置或缺站点地址时不投递。 */
export function serverAnalyticsTarget(env: {
  APP_URL?: string | undefined
  PLAUSIBLE_DOMAIN?: string | undefined
  PLAUSIBLE_HOST?: string | undefined
  PLAUSIBLE_SITES?: string | undefined
}): ServerAnalyticsTarget | null {
  const site = plausibleSite(templateConfig.features.analytics, env)
  return site && env.APP_URL ? { site, appUrl: env.APP_URL } : null
}

// Bindings and database clients belong to each invocation, never to module state.
export function createBillingContext(env: BillingEnv) {
  const db = env.db.business()
  const { providers } = createPaymentRuntime(env.config, templateConfig.billing.providers, {
    cache: env.cache,
    db,
  })
  return {
    db,
    providers,
    mail: {
      db,
      queue: {
        async send(message: EmailQueueMessage) {
          await env.emailQueue.send(message)
        },
      },
      appName: templateConfig.app.name,
      supportEmail: templateConfig.app.supportEmail,
    },
  }
}
type BillingContext = ReturnType<typeof createBillingContext>
type JobResult = { failures?: readonly unknown[]; failed?: number } | { cleared: number }

/** Attempt independent jobs even if one fails; expose only job names and failure counts. */
export async function runBillingJobs(jobs: readonly [string, () => Promise<JobResult>][]) {
  const failures: string[] = []
  for (const [name, run] of jobs) {
    try {
      const result = await run()
      const count = ('failures' in result ? result.failures?.length : 0) ?? 0
      const failed = ('failed' in result ? result.failed : 0) ?? 0
      if (count + failed > 0) failures.push(`${name} (${count + failed})`)
    } catch {
      failures.push(name)
    }
  }
  if (failures.length) throw new Error(`Billing jobs failed: ${failures.join(', ')}`)
}

async function completed(db: Database, deliveryId: string) {
  const [marker] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, deliveryId), eq(auditLog.action, BILLING_POSTPROCESS_ACTION)))
  return Boolean(marker)
}

/** Read committed deliveries only: no normalization, webhook replay, payment or credit writes. */
export async function postprocessBillingDelivery(context: BillingContext, deliveryId: string) {
  const [delivery] = await context.db
    .select()
    .from(webhookEvent)
    .where(eq(webhookEvent.id, deliveryId))
  if (!delivery || !['processed', 'ignored'].includes(delivery.status))
    throw new Error('Billing delivery is not committed')
  if (await completed(context.db, deliveryId)) return
  // Queue acceptance must precede the marker; failed external sends remain recoverable.
  await runBillingJobs([
    ['refund_notifications', () => flushRefundNotifications(context.mail)],
    ['compensation', () => runPendingCompensations(context)],
  ])
  await context.db.insert(auditLog).values({
    action: BILLING_POSTPROCESS_ACTION,
    targetType: 'webhook_event',
    targetId: deliveryId,
  })
}

export async function recoverBillingDeliveries(context: BillingContext) {
  const rows = await context.db
    .select({ id: webhookEvent.id })
    .from(webhookEvent)
    .where(
      and(
        inArray(webhookEvent.status, ['processed', 'ignored']),
        notExists(
          context.db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.targetId, sql`${webhookEvent.id}::text`),
                eq(auditLog.action, BILLING_POSTPROCESS_ACTION),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(webhookEvent.processedAt), asc(webhookEvent.id))
    .limit(BILLING_RECOVERY_LIMIT)
  const failures: string[] = []
  for (const row of rows) {
    try {
      await postprocessBillingDelivery(context, row.id)
    } catch {
      failures.push(row.id)
    }
  }
  return { failures }
}

export interface BillingScheduleFeatures {
  billing: boolean
  credits: boolean
}

/** 每轮最多发送的对账失败明细告警；其余合并为一条汇总（add-ops-safeguards D2 #9） */
export const RECONCILIATION_ALERT_CAP = 10

/**
 * 对账告警：每轮最多 10 条明细，超出部分在本轮结束时合并为 1 条含失败总数的汇总。
 * sourceId 只由「对账 + UTC 日 + 序号」组成，当天重跑或重放产生相同的 sourceId，
 * 运维通知消费者按审计标记跳过，因此每天最多 10 条明细与 1 条汇总。
 */
export function reconciliationAlerts(
  eventsQueue: QueueProducer<unknown> | undefined,
  now: Date,
  cap = RECONCILIATION_ALERT_CAP,
) {
  const day = utcDay(now)
  let total = 0
  return {
    alert: async (failure: Pick<CronFailure, 'workspaceId'>) => {
      total++
      if (total > cap) return
      await enqueueOperations(eventsQueue, [
        {
          event: 'reconciliation.failed',
          sourceId: `reconciliation:${day}:${total}`,
          workspaceId: failure.workspaceId,
        },
      ])
    },
    async flush() {
      if (total <= cap) return
      log.warn('job.cap_reached', { job: 'reconciliation_alerts', processed: cap, total })
      await enqueueOperations(eventsQueue, [
        { event: 'reconciliation.failed', sourceId: `reconciliation:${day}:summary`, count: total },
      ])
    },
  }
}

interface BillingJobContext {
  db: Database
  /** 未启用支付时为空；requires 含 billing 的任务才会运行 */
  billing: BillingContext | undefined
  now: Date
  alert: (failure: CronFailure) => Promise<void>
}
type BillingJob = BulkJobDefinition<BillingJobContext, JobResult & WithGuard> & {
  readonly cron: string
  readonly requires: readonly ('billing' | 'credits')[]
}

function payments(context: BillingJobContext) {
  if (!context.billing) throw new Error('Billing context unavailable')
  return context.billing
}

/**
 * 计费子任务的唯一登记处：runBillingSchedule 只遍历这个数组，守卫测试（bulk-jobs.guard.test.ts）
 * 也从这里枚举，与 docs/bulk-jobs.md 双向核对。数组顺序即同一触发器内的执行顺序。
 */
export const BILLING_JOBS: readonly BillingJob[] = [
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'credit_expiration',
      safety: {
        kind: 'destroy-credit',
        cap: CREDIT_EXPIRATION_CAP,
        capUnit: '空间',
        order: '最早到期批次的 expires_at 升序，再按空间 ID',
        timeGuard:
          '数据库时钟为基准、应用时钟偏差 ≤5 分钟；只处理 expires_at 在下限与基准之间的批次',
      },
      run: (c) => runCreditExpiration(c.db, c.now),
    }),
    cron: BILLING_HOURLY_CRON,
    requires: ['credits'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'annual_grants',
      safety: {
        kind: 'none',
        reason:
          '发放年付月度积分；同事务内的追溯过期只作用于本轮发放的空间，过期语义与 credit_expiration 相同',
      },
      run: (c) =>
        runAnnualGrants(payments(c).db, c.now, {
          subscriptionCreditGraceHours: templateConfig.billing.subscriptionCreditGraceHours,
        }),
    }),
    cron: BILLING_HOURLY_CRON,
    requires: ['credits', 'billing'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'hold_sweep',
      safety: {
        kind: 'destroy-credit',
        cap: HOLD_SWEEP_CAP,
        capUnit: '条预扣',
        order: 'expires_at 升序，再按 ID',
        timeGuard:
          '数据库时钟为基准、应用时钟偏差 ≤5 分钟；只处理 expires_at 在下限与基准之间的预扣',
      },
      run: (c) => runHoldSweep(c.db, c.now),
    }),
    cron: BILLING_RETRY_CRON,
    requires: ['credits'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'delivery_recovery',
      safety: {
        kind: 'none',
        reason: `只补跑已提交 webhook 的后处理（每轮 ${BILLING_RECOVERY_LIMIT} 条）；其中的退款邮件与补偿取消由 refund_notifications、compensation 各自的上限与时间防护约束`,
      },
      run: (c) => recoverBillingDeliveries(payments(c)),
    }),
    cron: BILLING_RETRY_CRON,
    requires: ['billing'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'compensation',
      safety: {
        kind: 'external-write',
        cap: COMPENSATION_LIMIT,
        capUnit: '个补偿任务',
        order: 'created_at 升序，再按 ID',
        timeGuard:
          '数据库时钟为基准、应用时钟偏差 ≤5 分钟；只领取 created_at 在下限与基准之间的任务',
      },
      run: (c) => runPendingCompensations(payments(c)),
    }),
    cron: BILLING_RETRY_CRON,
    requires: ['billing'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'refund_notifications',
      safety: {
        kind: 'send',
        cap: REFUND_NOTIFICATION_LIMIT,
        capUnit: '封邮件',
        order: 'updated_at 升序，再按 ID',
        timeGuard:
          '数据库时钟为基准、应用时钟偏差 ≤5 分钟；只发送 updated_at 在下限与基准之间的申请',
      },
      run: (c) => flushRefundNotifications(payments(c).mail),
    }),
    cron: BILLING_RETRY_CRON,
    requires: ['billing'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'subscription_reconciliation',
      safety: {
        kind: 'external-write',
        cap: SUBSCRIPTION_CANCEL_CAP,
        capUnit: '次外部取消',
        order: '本地 current_period_end 升序，再按 ID',
        timeGuard: `数据库时钟为基准、应用时钟偏差 ≤5 分钟；current_period_end 早于下限的订阅不取消并告警；失败告警每轮 ≤${RECONCILIATION_ALERT_CAP} 条明细 + 1 条汇总，按 UTC 日去重`,
      },
      run: (c) =>
        runSubscriptionReconciliation(payments(c).db, payments(c).providers, {
          alert: c.alert,
          now: () => c.now,
        }),
    }),
    cron: BILLING_DAILY_CRON,
    requires: ['billing'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'credit_reconciliation',
      safety: {
        kind: 'send',
        cap: RECONCILIATION_ALERT_CAP,
        capUnit: '条明细告警（与 subscription_reconciliation 共用）',
        order: '按空间 ID 对账；告警按失败发生顺序',
        timeGuard: '不按时间处理数据；告警 sourceId 为「对账 + UTC 日 + 序号」，当天重跑不重复发送',
      },
      run: (c) => runCreditReconciliation(c.db, { alert: c.alert }),
    }),
    cron: BILLING_DAILY_CRON,
    requires: ['credits'],
  },
  {
    ...defineBulkJob<BillingJobContext, JobResult & WithGuard>({
      id: 'refund_contact_cleanup',
      safety: {
        kind: 'delete',
        cap: REFUND_CONTACT_CLEANUP_CAP,
        capUnit: '条联系邮箱',
        order: '处理完成时间升序，再按 ID',
        timeGuard: `截止时间 = 数据库时钟 − 30 天（最小保留期 1 天），偏差 ≤5 分钟；完成时间早于下限的行不清空并告警`,
      },
      run: (c) => clearResolvedRefundContacts(payments(c).db, c.now),
    }),
    cron: BILLING_DAILY_CRON,
    requires: ['billing'],
  },
]

export async function runBillingSchedule(
  cron: string,
  env: BillingEnv,
  features: BillingScheduleFeatures = { billing: true, credits: true },
) {
  if (!features.billing && !features.credits) return
  if (![BILLING_HOURLY_CRON, BILLING_RETRY_CRON, BILLING_DAILY_CRON].includes(cron))
    throw new Error('Unknown billing cron')
  // 只有积分功能时不初始化支付 Provider；关闭的业务也不访问数据库。
  const billing = features.billing ? createBillingContext(env) : undefined
  const now = new Date()
  const alerts = reconciliationAlerts(env.eventsQueue, now)
  const context: BillingJobContext = {
    db: billing?.db ?? env.db.business(),
    billing,
    now,
    alert: alerts.alert,
  }
  const jobs = BILLING_JOBS.filter(
    (job) => job.cron === cron && job.requires.every((feature) => features[feature]),
  ).map(
    (job) =>
      [job.id, () => runBulkJob(job, context, env.eventsQueue)] as [
        string,
        () => Promise<JobResult>,
      ],
  )
  try {
    return await runBillingJobs(jobs)
  } finally {
    await alerts.flush()
  }
}
