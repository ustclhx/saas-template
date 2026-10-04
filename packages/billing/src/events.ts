import { grant, revokePaymentCredits } from '@saas/credits'
import {
  auditLog,
  billingCustomer,
  type Database,
  member,
  organization,
  type Payment,
  type PaymentProviderId,
  type Plan,
  type PlanPrice,
  payment,
  paymentRefund,
  plan,
  planPrice,
  purchase,
  type Subscription,
  subscription,
  user,
} from '@saas/db'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { WebhookContext, WebhookTransaction } from './pipeline.ts'
import type {
  CheckoutMetadata,
  NormalizedEvent,
  OrderSnapshot,
  PaymentProvider,
  SubscriptionSnapshot,
} from './provider.ts'

export type BillingProviders = Partial<Record<PaymentProviderId, PaymentProvider>>
interface Association {
  workspaceId: string
  price: PlanPrice
  plan: Plan
  metadata: CheckoutMetadata | null
  snapshot?: SubscriptionSnapshot | OrderSnapshot | undefined
}
export interface PreparedBillingEvents {
  associations: Map<NormalizedEvent, Association>
}
export interface BillingEventOptions {
  db: Database
  providers: BillingProviders
  subscriptionCreditGraceHours?: number
  now?: () => Date
}
/** The caller must persist a compensation job after rollback; this error contains no credentials. */
export class RenewingSubscriptionConflict extends Error {
  readonly code = 'RENEWING_SUBSCRIPTION_CONFLICT'
  constructor(
    public readonly compensation: {
      workspaceId: string
      provider: PaymentProviderId
      providerSubscriptionId: string
      providerPaymentId?: string
      kind?: 'initial' | 'renewal' | 'adjustment'
      amount?: number
      currency?: string
      winnerSubscriptionId: string
    },
  ) {
    super('RENEWING_SUBSCRIPTION_CONFLICT')
    this.name = 'RenewingSubscriptionConflict'
  }
}
const _key = (provider: PaymentProviderId, kind: string, id: string) => `${provider}:${kind}:${id}`
const scope = (provider: PaymentProviderId, id: string) =>
  and(eq(subscription.provider, provider), eq(subscription.providerSubscriptionId, id))
const orderScope = (provider: PaymentProviderId, id: string) =>
  and(eq(purchase.provider, provider), eq(purchase.providerOrderId, id))
const paymentScope = (provider: PaymentProviderId, id: string) =>
  and(eq(payment.provider, provider), eq(payment.providerPaymentId, id))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function money(amount: number, currency: string) {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > 2_147_483_647 ||
    currency.toUpperCase() !== 'USD'
  )
    throw new Error('Invalid billing amount or currency')
}
async function priceFor(
  db: Database | WebhookTransaction,
  id: string,
  provider: PaymentProviderId,
  providerPriceId?: string | null,
  expectedPlan?: string,
  requireActive = true,
) {
  const [row] = await db
    .select({ price: planPrice, plan })
    .from(planPrice)
    .innerJoin(plan, eq(plan.id, planPrice.planId))
    .where(eq(planPrice.id, id))
  if (
    !row ||
    (requireActive && (!row.price.active || !row.plan.active)) ||
    row.price.provider !== provider ||
    (expectedPlan && row.plan.id !== expectedPlan) ||
    (providerPriceId && row.price.providerPriceId !== providerPriceId)
  )
    throw new Error('Invalid active billing price association')
  money(row.price.amount, row.price.currency)
  if ((row.plan.type === 'subscription') !== Boolean(row.price.interval))
    throw new Error('Invalid billing plan interval')
  return row
}
async function validateMetadata(
  db: Database | WebhookTransaction,
  metadata: CheckoutMetadata | null,
) {
  if (
    !metadata ||
    ![metadata.workspaceId, metadata.userId, metadata.planPriceId].every((id) => uuid.test(id))
  )
    throw new Error('Missing or invalid billing metadata')
  const [owned] = await db
    .select({ email: user.email, banned: user.banned })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.organizationId, metadata.workspaceId),
        eq(member.userId, metadata.userId),
        isNull(organization.deletedAt),
      ),
    )
  if (!owned || owned.email === `deleted+${metadata.userId}@invalid` || owned.banned)
    throw new Error('Billing checkout user or workspace is ineligible')
}
/** Network enrichment only here, before the pipeline opens its processing transaction. */
export async function prepareBillingEvents(
  events: readonly NormalizedEvent[],
  db: Database,
  providers: BillingProviders,
): Promise<PreparedBillingEvents> {
  const prepared: PreparedBillingEvents = { associations: new Map() }
  for (const event of events) {
    let kind: 'subscription' | 'order'
    let id: string
    let snapshot: SubscriptionSnapshot | OrderSnapshot | undefined
    if (event.type === 'checkout.completed') {
      kind = event.mode === 'subscription' ? 'subscription' : 'order'
      id = event.mode === 'subscription' ? event.providerSubscriptionId : event.providerOrderId
    } else if (event.type === 'subscription.activated' || event.type === 'subscription.updated') {
      kind = 'subscription'
      id = event.subscription.providerSubscriptionId
      snapshot = event.subscription
    } else if (event.type === 'payment.succeeded') {
      kind = event.payment.kind === 'one_time' ? 'order' : 'subscription'
      id =
        event.payment.kind === 'one_time'
          ? event.payment.providerOrderId
          : event.payment.providerSubscriptionId
    } else if ('providerSubscriptionId' in event) {
      kind = 'subscription'
      id = event.providerSubscriptionId
    } else continue
    const associationKey = event
    const [local] =
      kind === 'subscription'
        ? await db.select().from(subscription).where(scope(event.provider, id))
        : await db.select().from(purchase).where(orderScope(event.provider, id))
    if (local) {
      const providerPriceId =
        event.type === 'payment.succeeded'
          ? (event.payment as typeof event.payment & { providerPriceId?: string | null })
              .providerPriceId
          : snapshot?.providerPriceId
      let priceId = local.planPriceId
      let recordedPrice: string | null = null
      if (event.type === 'payment.succeeded') {
        const [recorded] = await db
          .select()
          .from(payment)
          .where(paymentScope(event.provider, event.payment.providerPaymentId))
        if (recorded?.planPriceId) {
          priceId = recorded.planPriceId
          recordedPrice = recorded.planPriceId
        }
      }
      if (providerPriceId) {
        const [mapped] = await db
          .select()
          .from(planPrice)
          .where(
            and(
              eq(planPrice.provider, event.provider),
              eq(planPrice.providerPriceId, providerPriceId),
            ),
          )
        if (!mapped) throw new Error('Unknown provider price')
        if (recordedPrice && recordedPrice !== mapped.id)
          throw new Error('Payment provider price provenance mismatch')
        priceId = mapped.id
      }
      prepared.associations.set(associationKey, {
        workspaceId: local.workspaceId,
        ...(await priceFor(
          db,
          priceId,
          event.provider,
          providerPriceId,
          undefined,
          !(
            recordedPrice ||
            (event.type === 'payment.succeeded' &&
              event.payment.kind === 'renewal' &&
              providerPriceId)
          ),
        )),
        metadata: null,
        snapshot,
      })
      continue
    }
    if (!snapshot) {
      const provider = providers[event.provider]
      if (!provider || provider.id !== event.provider) throw new Error('Missing billing provider')
      snapshot =
        kind === 'subscription' ? await provider.getSubscription(id) : await provider.getOrder(id)
    }
    if (
      ('providerSubscriptionId' in snapshot
        ? snapshot.providerSubscriptionId
        : snapshot.providerOrderId) !== id
    )
      throw new Error('Remote billing object mismatch')
    const metadata = snapshot.metadata
    if (
      event.type === 'checkout.completed' &&
      (!metadata ||
        metadata.workspaceId !== event.metadata.workspaceId ||
        metadata.userId !== event.metadata.userId ||
        metadata.planPriceId !== event.metadata.planPriceId)
    )
      throw new Error('Checkout metadata repair mismatch')
    try {
      await validateMetadata(db, metadata)
    } catch (error) {
      await db.insert(auditLog).values({
        action: 'billing.association_failed',
        targetType: kind,
        targetId: id,
        meta: { provider: event.provider },
      })
      throw error
    }
    if (!metadata) throw new Error('Missing billing association')
    const priced = await priceFor(
      db,
      metadata.planPriceId,
      event.provider,
      snapshot.providerPriceId,
    )
    if ((kind === 'subscription') !== (priced.plan.type === 'subscription'))
      throw new Error('Billing object plan mismatch')
    if ('providerOrderId' in snapshot) {
      money(snapshot.amount, snapshot.currency)
      if (
        snapshot.amount !== priced.price.amount ||
        snapshot.currency.toUpperCase() !== priced.price.currency.toUpperCase()
      )
        throw new Error('Order price mismatch')
    }
    prepared.associations.set(associationKey, {
      workspaceId: metadata.workspaceId,
      ...priced,
      metadata,
      snapshot,
    })
  }
  return prepared
}
export async function lockWorkspaceBilling(tx: WebhookTransaction, workspaceId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${workspaceId}`}, 0))`,
  )
}
async function customer(
  tx: WebhookTransaction,
  workspaceId: string,
  provider: PaymentProviderId,
  customerId: string | null,
) {
  // PayPal payer IDs identify wallets, not workspace-specific customers.
  if (provider === 'paypal') customerId = null
  if (customerId)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`billing-customer:${provider}:${customerId}`}, 0))`,
    )
  const [existing] = await tx
    .select()
    .from(billingCustomer)
    .where(
      and(eq(billingCustomer.workspaceId, workspaceId), eq(billingCustomer.provider, provider)),
    )
  if (existing?.providerCustomerId && customerId && existing.providerCustomerId !== customerId)
    throw new Error('Billing customer association mismatch')
  if (customerId) {
    const [other] = await tx
      .select()
      .from(billingCustomer)
      .where(
        and(
          eq(billingCustomer.provider, provider),
          eq(billingCustomer.providerCustomerId, customerId),
          ne(billingCustomer.workspaceId, workspaceId),
        ),
      )
    if (other) throw new Error('Billing customer already associated')
  }
  if (!existing)
    await tx
      .insert(billingCustomer)
      .values({ workspaceId, provider, providerCustomerId: customerId })
  else if (!existing.providerCustomerId && customerId)
    await tx
      .update(billingCustomer)
      .set({ providerCustomerId: customerId })
      .where(eq(billingCustomer.id, existing.id))
}
const renewing = (status: Subscription['status'], cancel: boolean) =>
  ['active', 'trialing', 'past_due', 'paused'].includes(status) && !cancel
async function checkWinner(
  tx: WebhookTransaction,
  a: Association,
  event: NormalizedEvent,
  id: string,
  status: Subscription['status'],
  cancel: boolean,
) {
  if (!renewing(status, cancel)) return
  const [winner] = await tx
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.workspaceId, a.workspaceId),
        inArray(subscription.status, ['active', 'trialing', 'past_due', 'paused']),
        eq(subscription.cancelAtPeriodEnd, false),
        sql`not (${subscription.provider} = ${event.provider} and ${subscription.providerSubscriptionId} = ${id})`,
      ),
    )
  if (winner)
    throw new RenewingSubscriptionConflict({
      workspaceId: a.workspaceId,
      provider: event.provider,
      providerSubscriptionId: id,
      winnerSubscriptionId: winner.id,
      ...(event.type === 'payment.succeeded' && event.payment.kind !== 'one_time'
        ? {
            providerPaymentId: event.payment.providerPaymentId,
            kind: event.payment.kind,
            amount: event.payment.amount,
            currency: event.payment.currency,
          }
        : {}),
    })
}
/** UTC calendar arithmetic always derives from the original anchor (Jan 31 -> Feb 28 -> Mar 31). */
export function subscriptionMonthAnchor(anchor: Date, month: number) {
  const d = new Date(anchor)
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + month)
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(anchor.getUTCDate(), days))
  return d
}
/** Shared by webhook and cron; reloads owned immutable provenance after acquiring billing lock. */
export async function grantSubscriptionMonth(
  tx: WebhookTransaction,
  paid: Payment,
  price: PlanPrice,
  selectedPlan: Plan,
  month: number,
  now = new Date(),
  graceHours = 24,
) {
  await lockWorkspaceBilling(tx, paid.workspaceId)
  const [current] = await tx
    .select()
    .from(payment)
    .where(and(eq(payment.id, paid.id), eq(payment.workspaceId, paid.workspaceId)))
    .for('update')
  if (
    current?.status !== 'succeeded' ||
    current.refundedAmount > 0 ||
    !['initial', 'renewal'].includes(current.kind)
  )
    throw new Error('Payment is not eligible for subscription grants')
  if (
    current.planPriceId !== price.id ||
    price.planId !== selectedPlan.id ||
    price.provider !== current.provider ||
    !current.periodStart ||
    !current.periodEnd ||
    selectedPlan.type !== 'subscription'
  )
    throw new Error('Subscription payment provenance mismatch')
  if (!Number.isInteger(month) || month < 0 || month >= (price.interval === 'year' ? 12 : 1))
    throw new Error('Invalid subscription grant month')
  if (!Number.isFinite(graceHours) || graceHours < 0)
    throw new Error('Invalid subscription credit grace')
  const start = subscriptionMonthAnchor(current.periodStart, month)
  if (start > now || start >= current.periodEnd)
    throw new Error('Subscription grant month is not due')
  const [sub] = await tx
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.id, current.subscriptionId ?? ''),
        eq(subscription.workspaceId, current.workspaceId),
      ),
    )
  if (
    month > 0 &&
    (!sub ||
      (!['active', 'trialing'].includes(sub.status) &&
        !(
          sub.status === 'canceled' &&
          sub.cancelAtPeriodEnd &&
          sub.currentPeriodEnd &&
          now < sub.currentPeriodEnd
        )))
  )
    throw new Error('Subscription no longer eligible for monthly grants')
  if (selectedPlan.credits === 0) return
  const end =
    price.interval === 'year'
      ? new Date(
          Math.min(
            subscriptionMonthAnchor(current.periodStart, month + 1).getTime(),
            current.periodEnd.getTime(),
          ),
        )
      : current.periodEnd
  const expiresAt = selectedPlan.rollover
    ? selectedPlan.creditExpiryDays === null
      ? null
      : new Date(start.getTime() + selectedPlan.creditExpiryDays * 86_400_000)
    : new Date(end.getTime() + graceHours * 3_600_000)
  return grant(
    tx as unknown as Database,
    {
      workspaceId: current.workspaceId,
      source: 'subscription',
      sourceRef: `${current.id}:${month}`,
      paymentId: current.id,
      amount: selectedPlan.credits,
      expiresAt,
    },
    tx,
  )
}

export async function applyBillingEvent(
  tx: WebhookTransaction,
  event: NormalizedEvent,
  prepared: PreparedBillingEvents,
  options: Pick<BillingEventOptions, 'subscriptionCreditGraceHours' | 'now'> = {},
): Promise<void> {
  if (event.type === 'payment.refunded' || event.type === 'payment.disputed') {
    const [found] = await tx
      .select()
      .from(payment)
      .where(paymentScope(event.provider, event.providerPaymentId))
    if (!found) throw new Error('Payment association not found')
    await lockWorkspaceBilling(tx, found.workspaceId)
    const [paid] = await tx
      .select()
      .from(payment)
      .where(and(eq(payment.id, found.id), eq(payment.workspaceId, found.workspaceId)))
      .for('update')
    if (!paid) throw new Error('Payment association not found')
    money(event.amount, event.currency)
    if (
      event.currency.toUpperCase() !== paid.currency.toUpperCase() ||
      event.amount <= 0 ||
      event.amount > paid.amount
    )
      throw new Error('Refund or dispute amount mismatch')
    if (event.type === 'payment.disputed') {
      if (paid.status !== 'disputed') {
        await tx.update(payment).set({ status: 'disputed' }).where(eq(payment.id, paid.id))
        await revokePaymentCredits(
          tx as unknown as Database,
          { workspaceId: paid.workspaceId, paymentId: paid.id },
          tx,
        )
        await tx.insert(auditLog).values({
          workspaceId: paid.workspaceId,
          action: 'billing.payment_disputed',
          targetType: 'payment',
          targetId: paid.id,
          meta: { providerDisputeId: event.providerDisputeId },
        })
      }
      return
    }
    const refundIdentity = and(
      eq(paymentRefund.provider, event.provider),
      eq(paymentRefund.providerRefundId, event.providerRefundId),
    )
    const [claimed] = await tx
      .insert(paymentRefund)
      .values({
        workspaceId: paid.workspaceId,
        paymentId: paid.id,
        provider: event.provider,
        providerRefundId: event.providerRefundId,
        amount: event.amount,
        currency: paid.currency,
      })
      .onConflictDoNothing({ target: [paymentRefund.provider, paymentRefund.providerRefundId] })
      .returning()
    const [refund] = claimed
      ? [claimed]
      : await tx.select().from(paymentRefund).where(refundIdentity)
    if (
      !refund ||
      refund.paymentId !== paid.id ||
      refund.currency !== paid.currency ||
      refund.amount !== event.amount
    )
      throw new Error('Refund replay association mismatch')
    const [sum] = await tx
      .select({ total: sql<number>`coalesce(sum(${paymentRefund.amount}), 0)::int` })
      .from(paymentRefund)
      .where(
        and(eq(paymentRefund.workspaceId, paid.workspaceId), eq(paymentRefund.paymentId, paid.id)),
      )
    if (event.refundedAmount !== null) money(event.refundedAmount, event.currency)
    const total = Math.max(paid.refundedAmount, sum?.total ?? 0, event.refundedAmount ?? 0)
    if (total > paid.amount) throw new Error('Cumulative refund exceeds payment')
    await tx
      .update(payment)
      .set({
        refundedAmount: total,
        status:
          paid.status === 'disputed'
            ? 'disputed'
            : total === paid.amount
              ? 'refunded'
              : 'partially_refunded',
      })
      .where(eq(payment.id, paid.id))
    if (paid.purchaseId)
      await tx
        .update(purchase)
        .set({ status: 'refunded' })
        .where(and(eq(purchase.id, paid.purchaseId), eq(purchase.workspaceId, paid.workspaceId)))
    await revokePaymentCredits(
      tx as unknown as Database,
      { workspaceId: paid.workspaceId, paymentId: paid.id },
      tx,
    )
    if (claimed)
      await tx.insert(auditLog).values({
        workspaceId: paid.workspaceId,
        action: 'billing.payment_refunded',
        targetType: 'payment',
        targetId: paid.id,
        meta: {
          providerRefundId: event.providerRefundId,
          amount: event.amount,
          refundedAmount: total,
        },
      })
    return
  }
  const oneTime =
    (event.type === 'checkout.completed' && event.mode === 'one_time') ||
    (event.type === 'payment.succeeded' && event.payment.kind === 'one_time')
  const id =
    event.type === 'checkout.completed'
      ? event.mode === 'one_time'
        ? event.providerOrderId
        : event.providerSubscriptionId
      : event.type === 'payment.succeeded'
        ? event.payment.kind === 'one_time'
          ? event.payment.providerOrderId
          : event.payment.providerSubscriptionId
        : 'subscription' in event
          ? event.subscription.providerSubscriptionId
          : event.providerSubscriptionId
  const a = prepared.associations.get(event)
  if (!a) throw new Error('Billing event was not prepared')
  await lockWorkspaceBilling(tx, a.workspaceId)
  const customerId =
    event.type === 'payment.succeeded'
      ? (event.payment.providerCustomerId ?? a.snapshot?.providerCustomerId ?? null)
      : event.type === 'checkout.completed'
        ? event.providerCustomerId
        : (a.snapshot?.providerCustomerId ?? null)
  let sub: Subscription | undefined
  let purchaseId: string | undefined
  if (oneTime) {
    let [existing] = await tx.select().from(purchase).where(orderScope(event.provider, id))
    if (existing && existing.workspaceId !== a.workspaceId)
      throw new Error('Order workspace association changed')
    if (!existing) {
      await validateMetadata(tx, a.metadata)
      if (!a.metadata || a.plan.type !== 'credit_pack') throw new Error('Missing purchase metadata')
      ;[existing] = await tx
        .insert(purchase)
        .values({
          workspaceId: a.workspaceId,
          userId: a.metadata.userId,
          planId: a.plan.id,
          planPriceId: a.price.id,
          provider: event.provider,
          providerOrderId: id,
          amount: a.price.amount,
          currency: a.price.currency,
          raw: event.raw,
        })
        .returning()
    }
    if (!existing) throw new Error('Purchase insert failed')
    purchaseId = existing.id
  } else {
    ;[sub] = await tx.select().from(subscription).where(scope(event.provider, id))
    if (sub && sub.workspaceId !== a.workspaceId)
      throw new Error('Subscription workspace association changed')
    if (!sub) {
      await validateMetadata(tx, a.metadata)
      const snapshot = a.snapshot
      if (!snapshot || !('providerSubscriptionId' in snapshot))
        throw new Error('Missing subscription repair snapshot')
      await checkWinner(tx, a, event, id, snapshot.status, snapshot.cancelAtPeriodEnd)
      ;[sub] = await tx
        .insert(subscription)
        .values({
          workspaceId: a.workspaceId,
          planId: a.plan.id,
          planPriceId: a.price.id,
          provider: event.provider,
          providerSubscriptionId: id,
          status: snapshot.status,
          currentPeriodStart: snapshot.currentPeriodStart,
          currentPeriodEnd: snapshot.currentPeriodEnd,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          canceledAt: snapshot.canceledAt,
          trialEnd: snapshot.trialEnd,
          pastDueSince: snapshot.pastDueSince,
          lastEventAt: event.occurredAt,
          raw: snapshot.raw,
        })
        .returning()
    }
    if (!sub) throw new Error('Subscription insert failed')
  }
  await customer(tx, a.workspaceId, event.provider, customerId)
  if (event.type === 'payment.succeeded') {
    const p = event.payment
    money(p.amount, p.currency)
    if (
      p.kind !== 'adjustment' &&
      (p.amount !== a.price.amount || p.currency.toUpperCase() !== a.price.currency.toUpperCase())
    )
      throw new Error('Payment price mismatch')
    if (
      p.period &&
      (!(p.period.start < p.period.end) ||
        !Number.isFinite(p.period.start.getTime()) ||
        !Number.isFinite(p.period.end.getTime()))
    )
      throw new Error('Invalid payment period')
    if (p.refundedAmount !== null) money(p.refundedAmount, p.currency)
    if ((p.refundedAmount ?? 0) > p.amount) throw new Error('Payment refund exceeds gross')
    const [inserted] = await tx
      .insert(payment)
      .values({
        workspaceId: a.workspaceId,
        provider: event.provider,
        providerPaymentId: p.providerPaymentId,
        subscriptionId: sub?.id ?? null,
        purchaseId: purchaseId ?? null,
        planPriceId: a.price.id,
        periodStart: p.period?.start ?? null,
        periodEnd: p.period?.end ?? null,
        kind: p.kind,
        amount: p.amount,
        currency: p.currency.toUpperCase(),
        paidAt: p.paidAt,
        status: p.status,
        refundedAmount: p.refundedAmount ?? 0,
      })
      .onConflictDoNothing({ target: [payment.provider, payment.providerPaymentId] })
      .returning()
    const [paid] = inserted
      ? [inserted]
      : await tx.select().from(payment).where(paymentScope(event.provider, p.providerPaymentId))
    if (
      !paid ||
      paid.workspaceId !== a.workspaceId ||
      paid.subscriptionId !== (sub?.id ?? null) ||
      paid.purchaseId !== (purchaseId ?? null) ||
      paid.kind !== p.kind ||
      paid.planPriceId !== a.price.id ||
      paid.paidAt.getTime() !== p.paidAt.getTime() ||
      paid.amount !== p.amount ||
      paid.currency !== p.currency.toUpperCase() ||
      paid.periodStart?.getTime() !== p.period?.start.getTime() ||
      paid.periodEnd?.getTime() !== p.period?.end.getTime()
    )
      throw new Error('Payment replay provenance mismatch')
    const refunded = Math.max(paid.refundedAmount, p.refundedAmount ?? 0)
    const status =
      paid.status === 'disputed' || p.status === 'disputed'
        ? 'disputed'
        : refunded > 0
          ? refunded === paid.amount
            ? 'refunded'
            : 'partially_refunded'
          : p.status === 'refunded' || p.status === 'partially_refunded'
            ? p.status
            : paid.status
    if (refunded !== paid.refundedAmount || status !== paid.status)
      await tx
        .update(payment)
        .set({ refundedAmount: refunded, status })
        .where(eq(payment.id, paid.id))
    if (purchaseId && status === 'succeeded')
      await tx
        .update(purchase)
        .set({ status: 'paid', paidAt: paid.paidAt })
        .where(
          and(
            eq(purchase.id, purchaseId),
            eq(purchase.workspaceId, a.workspaceId),
            eq(purchase.status, 'pending'),
          ),
        )
    if (
      sub &&
      p.period &&
      p.kind !== 'adjustment' &&
      event.occurredAt >= sub.lastEventAt &&
      (!sub.currentPeriodEnd || p.period.end >= sub.currentPeriodEnd)
    ) {
      const nextStatus = sub.cancelAtPeriodEnd ? sub.status : 'active'
      await checkWinner(tx, a, event, id, nextStatus, sub.cancelAtPeriodEnd)
      await tx
        .update(subscription)
        .set({
          currentPeriodStart: p.period.start,
          currentPeriodEnd: p.period.end,
          status: nextStatus,
          lastEventAt: event.occurredAt,
          pastDueSince: null,
        })
        .where(and(eq(subscription.id, sub.id), eq(subscription.workspaceId, a.workspaceId)))
    }
    if (status !== 'succeeded' || refunded > 0) {
      await revokePaymentCredits(
        tx as unknown as Database,
        { workspaceId: paid.workspaceId, paymentId: paid.id },
        tx,
      )
      return
    }
    if (p.kind === 'initial' || p.kind === 'renewal')
      await grantSubscriptionMonth(
        tx,
        paid,
        a.price,
        a.plan,
        0,
        options.now?.() ?? new Date(),
        options.subscriptionCreditGraceHours ?? 24,
      )
    else if (p.kind === 'one_time' && a.plan.credits > 0)
      await grant(
        tx as unknown as Database,
        {
          workspaceId: a.workspaceId,
          source: 'purchase',
          sourceRef: paid.id,
          paymentId: paid.id,
          amount: a.plan.credits,
          expiresAt:
            a.plan.creditExpiryDays === null
              ? null
              : new Date(paid.paidAt.getTime() + a.plan.creditExpiryDays * 86_400_000),
        },
        tx,
      )
    return
  }
  if (
    !sub ||
    event.occurredAt < sub.lastEventAt ||
    event.type === 'checkout.completed' ||
    event.type === 'subscription.renewed'
  )
    return
  let changes: Partial<typeof subscription.$inferInsert> = {
    lastEventAt: event.occurredAt,
    raw: event.raw,
  }
  if (event.type === 'subscription.activated' || event.type === 'subscription.updated') {
    const s = event.subscription
    const scheduledPause =
      event.provider === 'paypal' &&
      sub.cancelAtPeriodEnd &&
      ['paused', 'active', 'trialing'].includes(s.status)
    changes = {
      ...changes,
      planId: a.plan.id,
      planPriceId: a.price.id,
      status: scheduledPause ? 'canceled' : s.status,
      cancelAtPeriodEnd:
        event.provider === 'paypal' && sub.cancelAtPeriodEnd ? true : s.cancelAtPeriodEnd,
      canceledAt: scheduledPause ? (sub.canceledAt ?? event.occurredAt) : s.canceledAt,
      trialEnd: s.trialEnd,
      pastDueSince: s.pastDueSince,
      raw: s.raw,
    }
    if (
      !sub.currentPeriodEnd ||
      (s.currentPeriodEnd && s.currentPeriodEnd >= sub.currentPeriodEnd)
    ) {
      changes.currentPeriodStart = s.currentPeriodStart
      changes.currentPeriodEnd = s.currentPeriodEnd
    }
  } else if (event.type === 'subscription.past_due') {
    changes.status =
      event.provider === 'paypal' && sub.cancelAtPeriodEnd && event.status === 'paused'
        ? 'canceled'
        : event.status
    changes.pastDueSince = event.pastDueSince
  } else if (event.type === 'subscription.canceled') {
    changes.status = event.status
    changes.canceledAt = event.canceledAt
    if (
      event.currentPeriodEnd &&
      (!sub.currentPeriodEnd || event.currentPeriodEnd >= sub.currentPeriodEnd)
    )
      changes.currentPeriodEnd = event.currentPeriodEnd
  }
  await checkWinner(
    tx,
    a,
    event,
    id,
    changes.status ?? sub.status,
    changes.cancelAtPeriodEnd ?? sub.cancelAtPeriodEnd,
  )
  await tx
    .update(subscription)
    .set(changes)
    .where(and(eq(subscription.id, sub.id), eq(subscription.workspaceId, a.workspaceId)))
}
export function createBillingEventHandler(options: BillingEventOptions) {
  return {
    prepare: (events: readonly NormalizedEvent[]) =>
      prepareBillingEvents(events, options.db, options.providers),
    handler: (
      tx: WebhookTransaction,
      event: NormalizedEvent,
      context: WebhookContext<PreparedBillingEvents>,
    ) => applyBillingEvent(tx, event, context.prepared, options),
  }
}
