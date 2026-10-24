// harden-audit-findings 7.3：月付↔年付周期末切换的 Stripe 平台侧实验，不经过应用、不关联任何 workspace。
// 用测试时钟复刻 changeStripePlan(atPeriodEnd) 的 schedule 写法，推进到周期末，记录每张发票的
// billing_reason 与事件序列，并按产品的 classifyStripeBillingReason 判定这张发票会被如何入账。
//
//   STRIPE_SECRET_KEY=sk_test_... EVIDENCE_DIR=... \
//     node --experimental-strip-types apps/web/e2e-live/stripe-test-clock-experiment.ts
//
// 只写 Stripe 测试模式；对象带 metadata saasAcceptance=harden-7.3，结束后删除测试时钟（连带 customer 与订阅）。
// 退出码：0 平台行为与产品分类一致；1 发现分类缺陷（周期末发票不会按续费入账）；2 无法确认（实验本身失败）。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACCEPTANCE_TAG,
  advanceTestClockTo,
  createClockCustomer,
  createTestClock,
  customerEvents,
  customerInvoices,
  deleteTestClock,
  productBillingKind,
  scheduleSummary,
  stripeApi,
  subscriptionSummary,
} from './stripe-test-clock.ts'

const PRODUCT_ID = 'saas_acceptance_harden_7_3'
const DAY = 86_400

async function experimentPrice(interval: 'month' | 'year', amount: number) {
  const lookupKey = `saas_acceptance_harden_7_3_${interval}`
  const found = await stripeApi<{ data: { id: string; unit_amount: number }[] }>('GET', 'prices', {
    lookup_keys: [lookupKey],
    active: true,
  })
  const existing = found.data[0]
  if (existing && existing.unit_amount === amount) return existing.id
  await stripeApi('GET', `products/${PRODUCT_ID}`).catch(() =>
    stripeApi('POST', 'products', {
      id: PRODUCT_ID,
      name: 'SaaS acceptance harden-7.3 (test clock experiment)',
      metadata: { saasAcceptance: ACCEPTANCE_TAG },
    }),
  )
  const price = await stripeApi<{ id: string }>('POST', 'prices', {
    product: PRODUCT_ID,
    currency: 'usd',
    unit_amount: amount,
    recurring: { interval },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    metadata: { saasAcceptance: ACCEPTANCE_TAG },
  })
  return price.id
}

/** 与 packages/billing/src/stripe/operations.ts changeStripePlan(atPeriodEnd=true) 的 schedule 结构一致 */
// anchor='phase_start' 不是产品当前写法，只作为修复候选的诊断变体，单独记录、不参与判定。
async function scheduleAtPeriodEnd(
  subscriptionId: string,
  targetPrice: string,
  interval: string,
  anchor?: 'phase_start',
) {
  const subscription = await subscriptionSummary(subscriptionId)
  const created = await stripeApi<{ id: string; phases: { start_date: number }[] }>(
    'POST',
    'subscription_schedules',
    { from_subscription: subscriptionId },
  )
  const start = created.phases[0]?.start_date
  if (!start) throw new Error('Schedule has no current phase')
  await stripeApi('POST', `subscription_schedules/${created.id}`, {
    end_behavior: 'release',
    metadata: { saasManaged: 'plan_change' },
    proration_behavior: 'none',
    phases: [
      {
        start_date: start,
        end_date: subscription.periodEnd,
        items: [{ price: subscription.priceId, quantity: 1 }],
        proration_behavior: 'none',
      },
      {
        start_date: subscription.periodEnd,
        duration: { interval, interval_count: 1 },
        items: [{ price: targetPrice, quantity: 1 }],
        proration_behavior: 'none',
        ...(anchor ? { billing_cycle_anchor: anchor } : {}),
      },
    ],
  })
  return created.id
}

async function runDirection(
  name: string,
  from: string,
  to: string,
  toInterval: 'month' | 'year',
  anchor?: 'phase_start',
) {
  const startedAt = Math.floor(Date.now() / 1000) - 60
  const clock = await createTestClock(name)
  try {
    const customer = await createClockCustomer(
      clock.id,
      `stripe-test-clock-${crypto.randomUUID()}@example.com`,
      true,
    )
    const created = await stripeApi<{ id: string }>('POST', 'subscriptions', {
      customer: customer.id,
      items: [{ price: from, quantity: 1 }],
      metadata: { saasAcceptance: ACCEPTANCE_TAG },
      payment_behavior: 'error_if_incomplete',
    })
    const initial = await subscriptionSummary(created.id)
    const scheduleId = await scheduleAtPeriodEnd(created.id, to, toInterval, anchor)
    const scheduled = await subscriptionSummary(created.id)
    const schedule = await scheduleSummary(scheduleId)
    const invoicesAfterSchedule = await customerInvoices(customer.id)
    // 周期末之后再多推进 1 天：测试时钟下自动开票约 1 小时后定稿并扣款
    await advanceTestClockTo(clock, initial.periodEnd + DAY)
    const renewed = await subscriptionSummary(created.id)
    const invoices = await customerInvoices(customer.id)
    const scheduleAfter = await scheduleSummary(scheduleId)
    const events = await customerEvents(customer.id, startedAt)
    const transition = invoices.find((invoice) => invoice.created >= initial.periodEnd)
    // setup：实验前提（schedule 已按产品写法建立、当前周期不开票）；outcome：规格要求的周期末结果
    const setup = {
      noInvoiceAtSchedule:
        invoicesAfterSchedule.length === 1 &&
        invoicesAfterSchedule[0]?.billingReason === 'subscription_create',
      scheduleShape:
        schedule.phases.length === 2 &&
        schedule.phases[0]?.end === initial.periodEnd &&
        schedule.phases[1]?.start === initial.periodEnd &&
        schedule.phases[1]?.items[0]?.providerPriceId === to &&
        schedule.phases.every((phase) => phase.prorationBehavior === 'none'),
      currentPeriodUnchanged:
        scheduled.priceId === from &&
        scheduled.periodEnd === initial.periodEnd &&
        scheduled.scheduleId === scheduleId,
    }
    const outcome = {
      switchedAtPeriodEnd:
        renewed.priceId === to &&
        renewed.interval === toInterval &&
        renewed.periodStart === initial.periodEnd &&
        renewed.status === 'active',
      transitionInvoicePaid:
        invoices.length === 2 &&
        transition?.status === 'paid' &&
        transition.amountPaid === transition.amountDue &&
        transition.lines.length === 1 &&
        transition.lines[0]?.priceId === to &&
        transition.lines[0]?.proration === false,
      transitionClassifiedAsRenewal:
        productBillingKind(transition?.billingReason ?? null) === 'renewal',
    }
    return {
      name,
      clock: clock.id,
      initial,
      scheduled,
      schedule,
      invoicesAfterSchedule,
      renewed,
      scheduleAfter,
      invoices,
      events,
      transition: transition
        ? {
            invoiceId: transition.id,
            billingReason: transition.billingReason,
            productKind: productBillingKind(transition.billingReason),
            amountPaid: transition.amountPaid,
          }
        : null,
      anchor: anchor ?? 'product-default',
      setup,
      outcome,
      verdict: !Object.values(setup).every(Boolean)
        ? 'inconclusive'
        : Object.values(outcome).every(Boolean)
          ? 'pass'
          : 'product-defect',
    }
  } finally {
    await deleteTestClock(clock.id)
  }
}

async function main() {
  const monthly = await experimentPrice('month', 1900)
  const yearly = await experimentPrice('year', 19000)
  const results = [
    await runDirection('monthly-to-yearly', monthly, yearly, 'year'),
    await runDirection('yearly-to-monthly', yearly, monthly, 'month'),
  ]
  const diagnostics = process.env.STRIPE_EXPERIMENT_SKIP_DIAGNOSTICS
    ? []
    : [await runDirection('monthly-to-yearly-phase-start', monthly, yearly, 'year', 'phase_start')]
  const verdict = results.some((result) => result.verdict === 'inconclusive')
    ? 'inconclusive'
    : results.every((result) => result.verdict === 'pass')
      ? 'pass'
      : 'product-defect'
  const report = {
    scenario: 'harden-7.3-stripe-test-clock-interval-change',
    capturedAt: new Date().toISOString(),
    stripeApiVersion: '2026-09-30.endive',
    prices: { monthly, yearly },
    verdict,
    results,
    diagnostics,
  }
  const directory = process.env.EVIDENCE_DIR
  if (directory) {
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'stripe-test-clock-experiment.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
  for (const result of [...results, ...diagnostics])
    console.log(
      `${result.name} [${result.anchor}] ${result.verdict}: setup=${JSON.stringify(result.setup)} outcome=${JSON.stringify(result.outcome)} transition=${JSON.stringify(result.transition)} renewed=${JSON.stringify({ interval: result.renewed.interval, periodStart: result.renewed.periodStart, periodEnd: result.renewed.periodEnd })}`,
    )
  console.log(`verdict: ${verdict}`)
  process.exitCode = verdict === 'pass' ? 0 : verdict === 'product-defect' ? 1 : 2
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'experiment failed')
  process.exitCode = 2
})
