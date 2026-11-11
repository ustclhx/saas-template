import { Button, Checkbox, Label, Select, SelectContent, SelectItem, SelectTrigger } from '@saas/ui'
import {
  createFileRoute,
  notFound as featureNotFound,
  getRouteApi,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import { trackEvent } from '../../../features/analytics/track.ts'
import {
  BillingCard,
  BillingError,
  BillingSection,
  BillingSkeleton,
  billingSections,
  CreditBalance,
  FreePlanCard,
  formatBillingDate,
  PackOption,
  SubscriptionStatusBadge,
  subscriptionStatus,
} from '../../../features/billing/billing-sections.tsx'
import {
  checkoutCustomer,
  getCustomerBilling,
  manageCustomerSubscription,
} from '../../../features/billing/customer.functions.ts'
import { getCustomerRefunds } from '../../../features/billing/refund.functions.ts'
import { RefundSection } from '../../../features/billing/refund-section.tsx'
import { m } from '../../../paraglide/messages.js'
import { getLocale } from '../../../paraglide/runtime.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/app/$slug/billing')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  loader: async ({ params }) => {
    const [billing, refunds] = await Promise.all([
      getCustomerBilling({ data: { slug: params.slug } }),
      getCustomerRefunds({ data: { slug: params.slug } }),
    ])
    return { ...billing, refundView: refunds }
  },
  staleTime: 0,
  component: BillingPage,
  pendingComponent: BillingSkeleton,
  errorComponent: BillingFailed,
})

const workspaceRoute = getRouteApi('/app/$slug')

// 免费积分分区的数据来源：注册赠送或每日领取任一开启（R3 合并后每日领取经配置开启）
const freeConfigured =
  templateConfig.credits.enabled &&
  (templateConfig.billing.signupBonusCredits > 0 || templateConfig.credits.dailyEnabled)

// 账单金额保留两位小数，与支付渠道账单一致
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(getLocale(), {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100)

function BillingFailed() {
  const router = useRouter()
  return <BillingError onRetry={() => void router.invalidate()} />
}

function BillingPage() {
  const page = Route.useLoaderData()
  const { dailyCredits } = workspaceRoute.useLoaderData()
  const { slug } = Route.useParams()
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState(
    page.catalog.providers.find((p) => p.available)?.id ?? page.catalog.providers[0]?.id ?? '',
  )
  const providerId = useId()
  const planId = useId()
  const confirmId = useId()
  const [priceId, setPriceId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const intent = useRef<{ key: string; uuid: string } | null>(null)
  useEffect(() => setReady(true), [])
  useEffect(() => trackEvent('paywall_view'), [])
  const owner = page.role === 'owner'
  const disabled = !ready || busy || page.readOnly || !owner
  const planOf = (id: string | undefined) => page.catalog.plans.find((plan) => plan.id === id)
  const sections = billingSections({
    plans: page.catalog.plans,
    prices: page.catalog.prices,
    subscriptionCount: page.subscriptions.length,
    summary: page.summary?.credits ?? null,
    freeConfigured,
  })
  const renewing = page.subscriptions.find(
    (sub) =>
      !sub.cancelAtPeriodEnd && ['active', 'trialing', 'past_due', 'paused'].includes(sub.status),
  )
  const now = Date.now()
  // 当前仍有效或仍在付费周期内的订阅；已结束的历史订阅见付款记录
  const currentSubscriptions = page.subscriptions.filter(
    (sub) =>
      ['active', 'trialing', 'past_due', 'paused'].includes(sub.status) ||
      (sub.currentPeriodEnd !== null && new Date(sub.currentPeriodEnd).getTime() > now),
  )
  const overlapping =
    page.subscriptions.filter(
      (sub) =>
        sub.currentPeriodEnd &&
        new Date(sub.currentPeriodEnd).getTime() > now &&
        ['active', 'trialing', 'canceled', 'expired', 'past_due'].includes(sub.status),
    ).length > 1
  const currentProvider = page.catalog.providers.find((p) => p.id === provider)
  const providerLabel = (p: (typeof page.catalog.providers)[number]) =>
    p.available ? p.id : m.billing_page_provider_unavailable({ provider: p.id })
  const providerAvailable = (id: string) =>
    page.catalog.providers.some((p) => p.id === id && p.available)
  const providerPrices = page.catalog.prices.filter(
    (price) => price.provider === provider && planOf(price.planId),
  )
  const planPrices = providerPrices.filter((price) => planOf(price.planId)?.type === 'subscription')
  const packPlans = page.catalog.plans.filter((plan) => plan.type === 'credit_pack')
  const intervalLabel = (interval: string | null) =>
    interval === 'year'
      ? ` ${m.pricing_page_per_year()}`
      : interval === 'month'
        ? ` ${m.pricing_page_per_month()}`
        : ''
  const priceLabel = (price: (typeof providerPrices)[number]) =>
    `${planOf(price.planId)?.name} · ${money(price.amount, price.currency)}${intervalLabel(price.interval)}${price.available ? '' : ` · ${m.billing_page_unavailable_suffix()}`}`
  const selected = planPrices.find((price) => price.id === priceId)
  const change = Boolean(selected) && renewing?.provider === 'stripe' && provider === 'stripe'
  const replacement = selected && !change ? renewing : undefined
  const currentInterval = page.catalog.prices.find(
    (price) => price.id === renewing?.planPriceId,
  )?.interval
  // 月付与年付互换由服务端安排在当前周期结束时生效，确认前先说明生效时间
  const intervalChange =
    change &&
    Boolean(selected?.interval && currentInterval) &&
    selected?.interval !== currentInterval
  const currentPlan = page.catalog.plans.find(
    (plan) => plan.key === page.summary?.currentSubscription?.planKey,
  )
  const packExpiry = (() => {
    const days = packPlans
      .map((plan) => plan.creditExpiryDays)
      .filter((value): value is number => value !== null)
    return days.length ? Math.min(...days) : null
  })()
  const showPurchase = owner && providerPrices.length > 0

  async function manage(subscriptionId: string, action: 'cancel' | 'resume' | 'portal' | 'change') {
    setBusy(true)
    setMessage('')
    try {
      const result = await manageCustomerSubscription({
        data: {
          slug,
          subscriptionId,
          action,
          ...(action === 'change' ? { planPriceId: priceId } : {}),
        },
      })
      if (!result.ok) {
        setMessage(errorMessage(result.error))
        return
      }
      if ('url' in result.result && result.result.url) {
        window.location.assign(result.result.url)
        return
      }
      setMessage(
        result.result.status === 'scheduled'
          ? m.billing_change_scheduled()
          : m.billing_page_updated(),
      )
      await router.invalidate()
    } catch {
      setMessage(m.billing_page_update_failed())
    } finally {
      setBusy(false)
    }
  }

  async function checkout(target: (typeof providerPrices)[number], replacing?: typeof renewing) {
    const replacingId = replacing && 'id' in replacing ? replacing.id : ''
    const key = `${slug}:${provider}:${target.id}:${replacingId}`
    if (intent.current?.key !== key) intent.current = { key, uuid: crypto.randomUUID() }
    setBusy(true)
    setMessage('')
    trackEvent('checkout_start', { plan: planOf(target.planId)?.key ?? '' })
    try {
      const result = await checkoutCustomer({
        data: {
          slug,
          provider: target.provider,
          planPriceId: target.id,
          idempotencyKey: intent.current.uuid,
          ...(replacingId
            ? { confirmSwitch: confirmed, expectedOldSubscriptionId: replacingId }
            : {}),
        },
      })
      if (result.ok) window.location.assign(result.result.url)
      else setMessage(errorMessage(result.error))
    } catch {
      setMessage(m.billing_page_checkout_failed())
    } finally {
      setBusy(false)
    }
  }

  async function submitPlan() {
    if (change && renewing && 'id' in renewing && renewing.id) {
      await manage(renewing.id, 'change')
      return
    }
    if (selected) await checkout(selected, replacement)
  }

  return (
    <div className="grid gap-8">
      <header className="grid gap-1">
        <h2 className="font-semibold text-display">{m.billing_page_title()}</h2>
        <p className="text-muted-foreground">{m.billing_page_desc()}</p>
      </header>

      {showPurchase && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Label htmlFor={providerId}>{m.billing_page_payment_method()}</Label>
          <Select
            value={currentProvider ? provider : ''}
            disabled={disabled}
            onValueChange={(value) => {
              setProvider(value)
              setPriceId('')
              setConfirmed(false)
              intent.current = null
            }}
          >
            <SelectTrigger
              id={providerId}
              className="w-full sm:w-56"
              placeholder={m.billing_page_payment_method()}
              valueLabel={currentProvider ? providerLabel(currentProvider) : undefined}
            />
            <SelectContent>
              {page.catalog.providers.map((p, index) => (
                <SelectItem key={p.id} index={index} value={p.id} disabled={!p.available}>
                  {providerLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!page.catalog.providers.some((p) => p.available) && (
            <p className="text-caption text-muted-foreground">
              {m.billing_page_payments_unavailable()}
            </p>
          )}
        </div>
      )}

      {message && (
        <p role="status" className="rounded-lg border bg-card px-4 py-3">
          {message}
        </p>
      )}

      {sections.subscription && (
        <BillingSection id="subscriptions" title={m.billing_page_subscription()}>
          {currentSubscriptions.length === 0 ? (
            <FreePlanCard
              action={
                owner && planPrices.length > 0 ? (
                  <Button asChild className="mt-3 sm:mt-0">
                    <a href="#choose-plan">{m.billing_page_view_plans()}</a>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            currentSubscriptions.map((sub) => {
              const status = subscriptionStatus(sub)
              const price = page.catalog.prices.find((p) => p.id === sub.planPriceId)
              const plan = planOf(price?.planId)
              const ending = status === 'ending' || status === 'ended' || status === 'paused'
              return (
                <BillingCard
                  key={sub.id}
                  className="px-6 py-5 shadow-surface-2 md:flex md:items-center md:justify-between md:gap-6"
                >
                  <div className="grid gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold text-title">{sub.name}</h4>
                      <SubscriptionStatusBadge status={status} />
                    </div>
                    <p className="text-muted-foreground">
                      {[
                        price &&
                          `${money(price.amount, price.currency)}${intervalLabel(price.interval)}`,
                        sub.provider,
                        ending
                          ? m.billing_page_access_ends({
                              date: formatBillingDate(sub.currentPeriodEnd),
                            })
                          : m.billing_page_next_billing({
                              date: formatBillingDate(sub.currentPeriodEnd),
                            }),
                        !ending &&
                          plan &&
                          plan.credits > 0 &&
                          m.billing_page_renewal_credits({ count: plan.credits }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  {owner && 'id' in sub && sub.id && (
                    <div className="mt-3 flex flex-wrap gap-2 md:mt-0">
                      <Button
                        variant="ghost"
                        disabled={disabled || !providerAvailable(sub.provider)}
                        onClick={() =>
                          void manage(sub.id, sub.cancelAtPeriodEnd ? 'resume' : 'cancel')
                        }
                      >
                        {sub.cancelAtPeriodEnd ? m.billing_page_resume() : m.billing_page_cancel()}
                      </Button>
                      {sub.provider === 'stripe' && (
                        <Button
                          variant="outline"
                          disabled={disabled || !providerAvailable('stripe')}
                          onClick={() => void manage(sub.id, 'portal')}
                        >
                          {m.billing_page_portal()}
                        </Button>
                      )}
                    </div>
                  )}
                </BillingCard>
              )
            })
          )}
          {overlapping && <p className="text-muted-foreground">{m.billing_page_overlap()}</p>}
          {owner && planPrices.length > 0 && (
            <BillingCard id="choose-plan" className="scroll-mt-6 gap-3">
              <h4 className="font-medium">{m.billing_page_choose_plan()}</h4>
              <div className="grid gap-2">
                <Label htmlFor={planId}>{m.billing_page_plan()}</Label>
                <Select
                  value={selected ? priceId : ''}
                  disabled={disabled}
                  onValueChange={(value) => {
                    setPriceId(value)
                    setConfirmed(false)
                    intent.current = null
                  }}
                >
                  <SelectTrigger
                    id={planId}
                    className="w-full"
                    placeholder={m.billing_page_plan_placeholder()}
                    valueLabel={selected ? priceLabel(selected) : undefined}
                  />
                  <SelectContent>
                    {planPrices.map((price, index) => (
                      <SelectItem
                        key={price.id}
                        index={index}
                        value={price.id}
                        disabled={!price.available}
                      >
                        {priceLabel(price)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {replacement && (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={confirmId}
                    disabled={disabled}
                    checked={confirmed}
                    onCheckedChange={(value) => setConfirmed(value === true)}
                  />
                  <Label htmlFor={confirmId} className="font-normal">
                    {m.billing_page_switch_confirm({
                      date: formatBillingDate(replacement.currentPeriodEnd),
                    })}
                  </Label>
                </div>
              )}
              {intervalChange && renewing && (
                <p className="text-muted-foreground">
                  {m.billing_change_interval_notice({
                    date: formatBillingDate(renewing.currentPeriodEnd),
                  })}
                </p>
              )}
              <Button
                className="justify-self-start"
                disabled={disabled || !selected?.available || Boolean(replacement && !confirmed)}
                onClick={() => void submitPlan()}
              >
                {change ? m.billing_page_change_plan() : m.billing_page_checkout()}
              </Button>
            </BillingCard>
          )}
        </BillingSection>
      )}

      {page.summary && (
        <CreditBalance
          summary={page.summary.credits}
          sections={sections}
          planCredits={currentPlan?.credits ?? null}
          renewalAt={page.summary.nextRenewalAt}
          packExpiry={packExpiry}
          daily={dailyCredits}
          packAction={
            showPurchase && packPlans.length > 0 ? (
              <Button asChild size="sm" variant="outline" className="justify-self-start">
                <a href="#credit-packs">{m.billing_page_buy_pack_link()}</a>
              </Button>
            ) : undefined
          }
          footer={
            <Link
              to="/app/$slug/usage"
              params={{ slug }}
              className="text-primary-text underline-offset-4 hover:underline"
            >
              {m.billing_page_usage_link()}
            </Link>
          }
        />
      )}

      {showPurchase && sections.packs && packPlans.length > 0 && (
        <BillingSection
          id="credit-packs"
          title={m.billing_page_packs_title()}
          aside={
            <span className="text-caption text-muted-foreground">
              {m.billing_page_packs_desc()}
            </span>
          }
        >
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packPlans.map((plan) => {
              const price = providerPrices.find((p) => p.planId === plan.id)
              return (
                <PackOption
                  key={plan.id}
                  name={plan.name}
                  credits={plan.credits}
                  price={
                    price
                      ? money(price.amount, price.currency)
                      : m.billing_page_payments_unavailable()
                  }
                  expiry={
                    plan.creditExpiryDays === null
                      ? m.billing_page_pack_permanent()
                      : m.billing_page_pack_expiry({ count: plan.creditExpiryDays })
                  }
                  disabled={disabled || !price?.available}
                  onBuy={() => {
                    if (price) void checkout(price)
                  }}
                />
              )
            })}
          </ul>
        </BillingSection>
      )}

      <RefundSection
        slug={slug}
        page={page.refundView}
        readOnly={page.readOnly}
        pendingPayments={page.refunds.filter((r) => r.status === 'pending').map((r) => r.paymentId)}
      />
      {owner && (
        <BillingSection id="payments" title={m.billing_page_history()}>
          <p className="text-muted-foreground">{m.billing_page_history_note()}</p>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-left">
              <thead className="border-b text-caption text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{m.billing_page_col_date()}</th>
                  <th className="px-3 py-2 font-medium">{m.billing_page_col_provider()}</th>
                  <th className="px-3 py-2 text-right font-medium">
                    {m.billing_page_col_amount()}
                  </th>
                  <th className="px-3 py-2 font-medium">{m.billing_page_col_status()}</th>
                  <th className="px-3 py-2 text-right font-medium">
                    {m.billing_page_col_refunded()}
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.payments.map((payment) => (
                  <tr key={payment.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{formatBillingDate(payment.paidAt)}</td>
                    <td className="px-3 py-2">{payment.provider}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(payment.amount, payment.currency)}
                    </td>
                    <td className="px-3 py-2">{payment.status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(payment.refundedAmount, payment.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {page.payments.length === 0 && (
              <p className="px-3 py-4 text-center text-muted-foreground">
                {m.billing_page_no_payments()}
              </p>
            )}
          </div>
          <h4 className="font-medium">{m.billing_page_refund_requests()}</h4>
          {page.refunds.map((refund) => (
            <p key={refund.id}>
              {formatBillingDate(refund.createdAt)} · {refund.status}
            </p>
          ))}
          {page.refunds.length === 0 && (
            <p className="text-muted-foreground">{m.billing_page_no_refunds()}</p>
          )}
        </BillingSection>
      )}
    </div>
  )
}

function errorMessage(code: string) {
  if (code === 'WORKSPACE_READ_ONLY') return m.billing_error_readonly()
  if (code === 'BILLING_OWNER_REQUIRED') return m.billing_error_owner()
  if (code === 'BILLING_PROVIDER_DISABLED' || code === 'BILLING_PRICE_UNAVAILABLE')
    return m.billing_error_unavailable()
  if (code === 'BILLING_SUBSCRIPTION_CHANGED' || code === 'BILLING_SWITCH_CONFIRMATION_REQUIRED')
    return m.billing_error_changed()
  return m.billing_error_unknown()
}
