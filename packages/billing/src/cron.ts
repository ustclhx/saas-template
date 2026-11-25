import {
  type CreditsTransaction,
  expireWorkspaceCredits,
  lockWorkspaceCredits,
  reconcileWorkspaceCredits,
} from '@saas/credits'
import {
  auditLog,
  bulkJobFloorSql,
  type CreditHold,
  creditGrant,
  creditHold,
  type Database,
  organization,
  payment,
  plan,
  planPrice,
  probeBulkJob,
  refundRequest,
  subscription,
} from '@saas/db'
import {
  BULK_JOB_TIME_FLOOR,
  type BulkJobOutcome,
  bulkJobOutcome,
  bulkJobSkipped,
  checkBulkJobTime,
  cutoffBefore,
} from '@saas/shared/bulk-job'
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, min, or, sql } from 'drizzle-orm'
import { billingErrorMessage } from './errors.ts'
import {
  applyBillingEvent,
  type BillingProviders,
  grantSubscriptionMonth,
  lockWorkspaceBilling,
  prepareBillingEvents,
  subscriptionMonthAnchor,
} from './events.ts'
import type { NormalizedEvent } from './provider.ts'

export interface CronFailure {
  job: string
  workspaceId: string
  targetId: string
  error: string
}
export interface CronOptions {
  /** Called after a durable audit entry; callback failures propagate to the scheduler. */
  alert?: (failure: CronFailure) => void | Promise<void>
  /** 仅供测试缩小每轮上限；生产使用下方常量 */
  cap?: number
}
export interface CronResult {
  processed: number
  failures: CronFailure[]
  /** 删除 / 销毁 / 外部写任务的防护结果（add-ops-safeguards），由 jobs 记录日志并告警 */
  guard?: BulkJobOutcome
}

/** 每轮上限（add-ops-safeguards D2，使用者 2026-11-25 确认）；超出部分留到下一轮 */
export const CREDIT_EXPIRATION_CAP = 200
export const HOLD_SWEEP_CAP = 500
export const SUBSCRIPTION_CANCEL_CAP = 50
export const REFUND_CONTACT_CLEANUP_CAP = 500
/** 退款联系邮箱的保留期与最小保留期 */
export const REFUND_CONTACT_RETENTION_DAYS = 30
const REFUND_CONTACT_MIN_RETENTION_MS = 86_400_000
async function failed(
  db: Database,
  result: CronResult,
  options: CronOptions,
  job: string,
  workspaceId: string,
  targetId: string,
  error: unknown,
) {
  const failure = { job, workspaceId, targetId, error: billingErrorMessage(error) }
  result.failures.push(failure)
  await db.insert(auditLog).values({
    workspaceId,
    action: `billing.cron.${job}.failed`,
    targetId,
    meta: { error: failure.error },
  })
  await options.alert?.(failure)
}

/**
 * Expire even fully reserved grants; allocations settle through the credits API later.
 * 每轮最多 200 个空间，按最早到期批次排序；以数据库时钟为基准，到期时间早于下限的批次不处理并告警。
 */
export async function runCreditExpiration(
  db: Database,
  now = new Date(),
  options: CronOptions = {},
): Promise<CronResult> {
  const { dbNow, outOfRange } = await probeBulkJob(
    db,
    sql`select count(*) from ${creditGrant} where ${creditGrant.status}='active' and ${creditGrant.expiresAt}<${bulkJobFloorSql}`,
  )
  const verdict = checkBulkJobTime({ appNow: now, dbNow })
  if (!verdict.ok) return { processed: 0, failures: [], guard: bulkJobSkipped(verdict.reason) }
  const workspaces = await db
    .select({ workspaceId: creditGrant.workspaceId })
    .from(creditGrant)
    .where(
      and(
        eq(creditGrant.status, 'active'),
        gte(creditGrant.expiresAt, BULK_JOB_TIME_FLOOR),
        lte(creditGrant.expiresAt, dbNow),
      ),
    )
    .groupBy(creditGrant.workspaceId)
    .orderBy(asc(min(creditGrant.expiresAt)), asc(creditGrant.workspaceId))
    .limit(options.cap ?? CREDIT_EXPIRATION_CAP)
  const result: CronResult = { processed: 0, failures: [] }
  for (const { workspaceId } of workspaces) {
    try {
      await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, workspaceId)
        await expireWorkspaceCredits(db, workspaceId, tx, dbNow, BULK_JOB_TIME_FLOOR)
      })
      result.processed++
    } catch (error) {
      await failed(db, result, options, 'expiration', workspaceId, workspaceId, error)
    }
  }
  result.guard = bulkJobOutcome({
    processed: workspaces.length,
    cap: options.cap ?? CREDIT_EXPIRATION_CAP,
    outOfRange,
  })
  return result
}

/**
 * Historical payment periods and prices determine month 0..11, including inactive prices.
 * Late months retain retrospective expiry and expire in the same transaction: no
 * spendable resurrection. Only source claims persist; no in-memory execution history.
 */
export async function runAnnualGrants(
  db: Database,
  now = new Date(),
  options: CronOptions & { subscriptionCreditGraceHours?: number } = {},
): Promise<CronResult> {
  const workspaces = await db
    .selectDistinct({ workspaceId: payment.workspaceId })
    .from(payment)
    .innerJoin(planPrice, eq(planPrice.id, payment.planPriceId))
    .where(
      and(
        // 部分退款的年付继续按未退款份额发放后续月份；全额退款与争议停止发放。
        inArray(payment.status, ['succeeded', 'partially_refunded']),
        lt(payment.refundedAmount, payment.amount),
        inArray(payment.kind, ['initial', 'renewal']),
        eq(planPrice.interval, 'year'),
        lte(payment.periodStart, now),
      ),
    )
  const result: CronResult = { processed: 0, failures: [] }
  for (const { workspaceId } of workspaces) {
    try {
      const count = await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, workspaceId)
        const rows = await tx
          .select({ paid: payment, price: planPrice, selectedPlan: plan })
          .from(payment)
          .innerJoin(planPrice, eq(planPrice.id, payment.planPriceId))
          .innerJoin(plan, eq(plan.id, planPrice.planId))
          .innerJoin(subscription, eq(subscription.id, payment.subscriptionId))
          .innerJoin(organization, eq(organization.id, payment.workspaceId))
          .where(
            and(
              eq(payment.workspaceId, workspaceId),
              eq(subscription.workspaceId, workspaceId),
              isNull(organization.deletedAt),
              inArray(payment.status, ['succeeded', 'partially_refunded']),
              lt(payment.refundedAmount, payment.amount),
              inArray(payment.kind, ['initial', 'renewal']),
              eq(planPrice.interval, 'year'),
              or(
                inArray(subscription.status, ['active', 'trialing']),
                and(
                  eq(subscription.status, 'canceled'),
                  eq(subscription.cancelAtPeriodEnd, true),
                  lt(sql`${now.toISOString()}::timestamptz`, subscription.currentPeriodEnd),
                ),
              ),
            ),
          )
        let granted = 0
        for (const { paid, price, selectedPlan } of rows) {
          if (!paid.periodStart || !paid.periodEnd) throw new Error('Missing annual paid period')
          for (let month = 0; month < 12; month++) {
            const start = subscriptionMonthAnchor(paid.periodStart, month)
            if (start > now || start >= paid.periodEnd) break
            // Source identity is global, including revoked/expired grants and other workspaces.
            const [claimed] = await tx
              .select({ id: creditGrant.id })
              .from(creditGrant)
              .where(
                and(
                  eq(creditGrant.source, 'subscription'),
                  eq(creditGrant.sourceRef, `${paid.id}:${month}`),
                ),
              )
            if (claimed) continue
            const created = await grantSubscriptionMonth(
              tx,
              paid,
              price,
              selectedPlan,
              month,
              now,
              options.subscriptionCreditGraceHours ?? 24,
            )
            if (created) granted++
          }
        }
        await expireWorkspaceCredits(db, workspaceId, tx, now)
        return granted
      })
      result.processed += count
    } catch (error) {
      await failed(db, result, options, 'annual_grants', workspaceId, workspaceId, error)
    }
  }
  return result
}

export type HoldSweepHandler = (context: {
  db: Database
  /** DB-only handler: pass this transaction to credits.capture/release; no network I/O. */
  tx: CreditsTransaction
  hold: CreditHold
  now: Date
}) => Promise<void>
// Module-startup business handlers only; the finite refType set bounds this registry.
const holdSweepers = new Map<CreditHold['refType'], HoldSweepHandler>()
export function registerHoldSweeper(refType: CreditHold['refType'], handler: HoldSweepHandler) {
  if (holdSweepers.has(refType)) throw new Error(`Hold sweeper already registered: ${refType}`)
  holdSweepers.set(refType, handler)
  return () => {
    if (holdSweepers.get(refType) === handler) holdSweepers.delete(refType)
  }
}

/**
 * DB-only business handlers own settlement; no AI-specific policies are installed here.
 * 每轮最多 500 条，按 expires_at 升序；以数据库时钟为基准，到期时间早于下限的预扣不结算并告警。
 */
export async function runHoldSweep(
  db: Database,
  now = new Date(),
  options: CronOptions = {},
): Promise<CronResult> {
  const { dbNow, outOfRange } = await probeBulkJob(
    db,
    sql`select count(*) from ${creditHold} where ${creditHold.status}='held' and ${creditHold.expiresAt}<${bulkJobFloorSql}`,
  )
  const verdict = checkBulkJobTime({ appNow: now, dbNow })
  if (!verdict.ok) return { processed: 0, failures: [], guard: bulkJobSkipped(verdict.reason) }
  const inRange = and(
    gte(creditHold.expiresAt, BULK_JOB_TIME_FLOOR),
    lte(creditHold.expiresAt, dbNow),
  )
  const holds = await db
    .select()
    .from(creditHold)
    .where(and(eq(creditHold.status, 'held'), inRange))
    .orderBy(asc(creditHold.expiresAt), asc(creditHold.id))
    .limit(options.cap ?? HOLD_SWEEP_CAP)
  const result: CronResult = { processed: 0, failures: [] }
  for (const candidate of holds) {
    try {
      const handled = await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, candidate.workspaceId)
        await lockWorkspaceCredits(tx, candidate.workspaceId)
        const [active] = await tx
          .select()
          .from(creditHold)
          .where(
            and(
              eq(creditHold.id, candidate.id),
              eq(creditHold.workspaceId, candidate.workspaceId),
              eq(creditHold.status, 'held'),
              inRange,
            ),
          )
        if (!active) return false
        const handler = holdSweepers.get(active.refType)
        if (!handler) throw new Error(`No hold sweeper registered: ${active.refType}`)
        await handler({ db, tx, hold: active, now: dbNow })
        return true
      })
      if (handled) result.processed++
    } catch (error) {
      await failed(db, result, options, 'hold_sweep', candidate.workspaceId, candidate.id, error)
    }
  }
  result.guard = bulkJobOutcome({
    processed: holds.length,
    cap: options.cap ?? HOLD_SWEEP_CAP,
    outOfRange,
  })
  return result
}

/**
 * Fetch remote state outside transactions; normalization cannot synthesize payments.
 * 只读同步不受限；PayPal 到期取消（外部写）每轮最多 50 次，按 current_period_end 升序。
 * 时钟偏差超过 5 分钟时本轮只同步不取消；到期时间早于下限的订阅不取消并告警。
 */
export async function runSubscriptionReconciliation(
  db: Database,
  providers: BillingProviders,
  options: CronOptions & { now?: () => Date } = {},
): Promise<CronResult> {
  const clock = options.now ?? (() => new Date())
  const elapsedCancel = and(
    eq(subscription.provider, 'paypal'),
    eq(subscription.cancelAtPeriodEnd, true),
  )
  const { dbNow, outOfRange } = await probeBulkJob(
    db,
    sql`select count(*) from ${subscription} where ${elapsedCancel} and ${subscription.currentPeriodEnd}<${bulkJobFloorSql}`,
  )
  const verdict = checkBulkJobTime({ appNow: clock(), dbNow })
  const rows = await db
    .select()
    .from(subscription)
    .where(
      or(
        inArray(subscription.status, ['active', 'trialing', 'past_due', 'paused']),
        and(eq(subscription.status, 'canceled'), eq(subscription.cancelAtPeriodEnd, true)),
      ),
    )
    .orderBy(sql`${subscription.currentPeriodEnd} asc nulls last`, asc(subscription.id))
  const result: CronResult = { processed: 0, failures: [] }
  let cancels = 0
  let capReached = false
  for (const row of rows) {
    try {
      const provider = providers[row.provider]
      if (!provider || provider.id !== row.provider)
        throw new Error('Missing or wrong billing provider')
      const [current] = await db.select().from(subscription).where(eq(subscription.id, row.id))
      if (!current) continue
      const fetchSnapshot = async () => {
        const remote = await provider.getSubscription(current.providerSubscriptionId)
        if (remote.providerSubscriptionId !== current.providerSubscriptionId)
          throw new Error('Remote billing object mismatch')
        return remote
      }
      let snapshot = await fetchSnapshot()
      // PayPal 终止后本地仍保留 cancelAtPeriodEnd=true，行会被再次选中；
      // 先读远端状态，已终止（CANCELLED/EXPIRED）时不再 cancel，保证幂等
      if (
        verdict.ok &&
        current.provider === 'paypal' &&
        current.cancelAtPeriodEnd &&
        current.currentPeriodEnd &&
        current.currentPeriodEnd.getTime() >= BULK_JOB_TIME_FLOOR.getTime() &&
        current.currentPeriodEnd <= dbNow &&
        snapshot.status !== 'canceled' &&
        snapshot.status !== 'expired'
      ) {
        if (cancels >= (options.cap ?? SUBSCRIPTION_CANCEL_CAP)) {
          // 超出上限的取消留到下一轮；本轮仍按远端快照同步本地状态
          capReached = true
        } else {
          cancels++
          await provider.cancelSubscription(current.providerSubscriptionId, { atPeriodEnd: false })
          snapshot = await fetchSnapshot()
        }
      }
      const now = clock()
      const event: NormalizedEvent = {
        provider: current.provider,
        type: 'subscription.updated',
        subscription: { ...snapshot, metadata: null },
        occurredAt: now,
        raw: snapshot.raw,
      }
      const prepared = await prepareBillingEvents([event], db, providers)
      await db.transaction((tx) => applyBillingEvent(tx, event, prepared, { now: () => now }))
      result.processed++
    } catch (error) {
      await failed(
        db,
        result,
        options,
        'subscription_reconciliation',
        row.workspaceId,
        row.id,
        error,
      )
    }
  }
  result.guard = bulkJobOutcome({
    processed: cancels,
    cap: options.cap ?? SUBSCRIPTION_CANCEL_CAP,
    capReached,
    tripped: verdict.ok ? [] : [{ reason: verdict.reason }],
    outOfRange,
  })
  return result
}

export async function runCreditReconciliation(
  db: Database,
  options: CronOptions = {},
): Promise<CronResult> {
  const workspaces = await db.select({ workspaceId: organization.id }).from(organization)
  const result: CronResult = { processed: 0, failures: [] }
  for (const { workspaceId } of workspaces) {
    try {
      const snapshot = await db.transaction(async (tx) => {
        await lockWorkspaceBilling(tx, workspaceId)
        return reconcileWorkspaceCredits(db, workspaceId, tx)
      })
      if (!snapshot.consistent)
        throw new Error(`Credit invariant difference: ${snapshot.difference}`)
      result.processed++
    } catch (error) {
      await failed(db, result, options, 'credit_reconciliation', workspaceId, workspaceId, error)
    }
  }
  return result
}

/**
 * Approval is not resolution: refunded uses updatedAt (completion), rejected uses review time.
 * 每轮最多 500 条，按完成时间升序；截止时间以数据库时钟为准，完成时间早于下限的行不清空并告警。
 */
export async function clearResolvedRefundContacts(
  db: Database,
  now = new Date(),
  {
    retentionDays = REFUND_CONTACT_RETENTION_DAYS,
    cap = REFUND_CONTACT_CLEANUP_CAP,
  }: { retentionDays?: number; cap?: number } = {},
) {
  const resolvedAt = sql`case when ${refundRequest.status}='rejected'
    then coalesce(${refundRequest.reviewedAt}, ${refundRequest.updatedAt}) else ${refundRequest.updatedAt} end`
  const resolved = and(
    isNotNull(refundRequest.contactEmail),
    inArray(refundRequest.status, ['rejected', 'refunded']),
  )
  const { dbNow, outOfRange } = await probeBulkJob(
    db,
    sql`select count(*) from ${refundRequest} where ${resolved} and ${resolvedAt}<${bulkJobFloorSql}`,
  )
  const cutoff = cutoffBefore(dbNow, retentionDays * 86_400_000)
  const verdict = checkBulkJobTime({
    appNow: now,
    dbNow,
    cutoffs: [{ at: cutoff, minRetentionMs: REFUND_CONTACT_MIN_RETENTION_MS }],
  })
  if (!verdict.ok) return { cleared: 0, guard: bulkJobSkipped(verdict.reason) }
  const candidates = db
    .select({ id: refundRequest.id })
    .from(refundRequest)
    .where(
      and(
        resolved,
        sql`${resolvedAt} >= ${bulkJobFloorSql}`,
        sql`${resolvedAt} < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(resolvedAt), asc(refundRequest.id))
    .limit(cap)
  const cleared = await db
    .update(refundRequest)
    .set({ contactEmail: null })
    .where(and(inArray(refundRequest.id, candidates), isNotNull(refundRequest.contactEmail)))
    .returning({ id: refundRequest.id })
  return {
    cleared: cleared.length,
    guard: bulkJobOutcome({
      processed: cleared.length,
      cap,
      outOfRange,
    }),
  }
}
