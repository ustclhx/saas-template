import { Alert, AlertDescription, AlertTitle, Button, cn } from '@saas/ui'
import {
  Calendar,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  CreditCard,
  Package,
  Plus,
} from '@saas/ui/icons'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import {
  type BillingInterval,
  groupPricingPlans,
  type PricingPlan,
  packExpiryDays,
  planPrice,
  pricingFeatures,
  yearlySavingPercent,
} from './pricing-data.ts'
import { pricingFeatureLabel } from './pricing-features.ts'
import { formatPrice } from './sections/pricing.tsx'

const credits = (count: number) => new Intl.NumberFormat(getLocale()).format(count)

/** 定价页首屏：标题与说明，加载、错误与空状态共用 */
export function PricingHero() {
  return (
    <section className="px-4 pt-16 pb-10">
      <div className="mx-auto grid max-w-3xl justify-items-center gap-4 text-center">
        <span className="rounded-full border px-3 py-1 text-caption text-muted-foreground">
          {m.pricing_page_eyebrow()}
        </span>
        <h1 className="font-bold text-4xl tracking-tight">{m.pricing_page_title()}</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">{m.pricing_page_subtitle()}</p>
      </div>
    </section>
  )
}

/** 积分规则条：只在订阅与积分包并存时说明叠加和扣费顺序 */
export function PricingFacts({ packExpiry }: { packExpiry: number | null }) {
  const facts = [
    {
      icon: Calendar,
      title: m.pricing_page_fact_monthly_title(),
      desc: m.pricing_page_fact_monthly_desc(),
    },
    packExpiry === null
      ? {
          icon: Package,
          title: m.pricing_page_fact_pack_title(),
          desc: m.pricing_page_fact_pack_desc(),
        }
      : {
          icon: Package,
          title: m.pricing_page_fact_pack_title_expiry(),
          desc: m.pricing_page_fact_pack_desc_expiry({ count: packExpiry }),
        },
    {
      icon: Plus,
      title: m.pricing_page_fact_stack_title(),
      desc: m.pricing_page_fact_stack_desc(),
    },
    {
      icon: Clock,
      title: m.pricing_page_fact_order_title(),
      desc: m.pricing_page_fact_order_desc(),
    },
  ]
  return (
    <section aria-label={m.pricing_page_facts_label()} className="px-4 pb-10">
      {/* 间隙露出边框色作分隔线，任意列数下都不需要按位置判断边框 */}
      <ul className="mx-auto grid max-w-6xl gap-px overflow-hidden rounded-xl bg-border shadow-surface-2 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map(({ icon: Icon, title, desc }) => (
          <li key={title} className="flex gap-3 bg-card px-5 py-4">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-active"
            >
              <Icon className="size-4" />
            </span>
            <span className="grid gap-0.5">
              <span className="font-semibold text-subtitle">{title}</span>
              <span className="text-caption text-muted-foreground">{desc}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 订阅与积分包并列：月付/年付切换只作用于订阅组；只有积分包时不显示切换与订阅组，
 * 只有订阅时订阅组占满宽度。两组都没有时显示空状态。
 */
export function PricingGroups({
  plans,
  paymentsAvailable,
  initialInterval = 'month',
}: {
  plans: readonly PricingPlan[]
  paymentsAvailable: boolean
  initialInterval?: BillingInterval
}) {
  const [interval, setInterval] = useState<BillingInterval>(initialInterval)
  const groups = groupPricingPlans(plans)
  if (groups.subscriptions.length === 0 && groups.creditPacks.length === 0) return <PricingEmpty />
  const both = groups.subscriptions.length > 0 && groups.creditPacks.length > 0
  const hasYearly = groups.subscriptions.some((plan) =>
    plan.prices.some((price) => price.interval === 'year'),
  )
  const saving = yearlySavingPercent(groups.subscriptions)
  const packExpiry = packExpiryDays(groups.creditPacks)
  return (
    <div className="grid gap-4">
      <div className={cn('grid items-start gap-8', both && 'lg:grid-cols-10')}>
        {groups.subscriptions.length > 0 && (
          <section aria-labelledby="pricing-subscriptions" className="grid gap-4 lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <GroupHeading
                id="pricing-subscriptions"
                title={m.pricing_page_subscriptions()}
                desc={m.pricing_page_subscriptions_desc()}
              />
              {hasYearly && (
                <fieldset className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
                  <legend className="sr-only">{m.pricing_page_cycle()}</legend>
                  {(['month', 'year'] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="compact"
                      variant={interval === value ? 'outline' : 'ghost'}
                      aria-pressed={interval === value}
                      className={cn(interval === value && 'bg-surface-3 shadow-surface-2')}
                      onClick={() => setInterval(value)}
                    >
                      {value === 'month' ? m.pricing_page_monthly() : m.pricing_page_yearly()}
                      {value === 'year' && saving > 0 && (
                        <span className="rounded-full bg-success/10 px-1.5 text-caption text-success">
                          {m.pricing_page_save({ percent: saving })}
                        </span>
                      )}
                    </Button>
                  ))}
                </fieldset>
              )}
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              {groups.subscriptions.map((plan) => (
                <SubscriptionCard key={plan.key} plan={plan} interval={interval} />
              ))}
            </ul>
          </section>
        )}
        {groups.creditPacks.length > 0 && (
          <section aria-labelledby="pricing-packs" className="grid gap-4 lg:col-span-3">
            <div className="flex min-h-8 items-center">
              <GroupHeading
                id="pricing-packs"
                title={m.pricing_page_packs()}
                desc={
                  packExpiry === null
                    ? m.pricing_page_packs_desc()
                    : m.pricing_page_packs_desc_expiry()
                }
              />
            </div>
            <ul className={cn('grid gap-3', !both && 'sm:grid-cols-2 lg:grid-cols-3')}>
              {groups.creditPacks.map((plan) => (
                <PackRow key={plan.key} plan={plan} />
              ))}
            </ul>
            {both && (
              <p className="text-caption text-muted-foreground">{m.pricing_page_pack_order()}</p>
            )}
          </section>
        )}
      </div>
      {!paymentsAvailable && (
        <p role="status" className="text-caption text-muted-foreground">
          {m.pricing_page_payments_unavailable()}
        </p>
      )}
    </div>
  )
}

function GroupHeading({ id, title, desc }: { id: string; title: string; desc: string }) {
  return (
    <div className="grid gap-0.5">
      <h2 id={id} className="font-semibold text-title">
        {title}
      </h2>
      <p className="text-caption text-muted-foreground">{desc}</p>
    </div>
  )
}

function SubscriptionCard({ plan, interval }: { plan: PricingPlan; interval: BillingInterval }) {
  const locale = getLocale()
  const price = planPrice(plan, interval)
  const free = !price && plan.key === 'free'
  const yearlyMonthly =
    price && interval === 'year'
      ? formatPrice(Math.round(price.amount / 12), price.currency, locale)
      : null
  const entitlements = [
    plan.credits > 0 && m.pricing_page_credits_monthly({ count: credits(plan.credits) }),
    ...pricingFeatures(plan.features)
      // 布尔权益只列出「有」的项；水印为负向权益，不作为卖点展示
      .filter((item) => item.key !== 'watermark' && item.value !== false)
      .filter((item) => item.key !== 'models' || item.value.length > 0)
      .map(pricingFeatureLabel),
  ].filter((item): item is string => Boolean(item))
  return (
    <li
      className={cn(
        'relative flex flex-col gap-4 rounded-xl bg-card p-6',
        plan.highlighted ? 'shadow-surface-4 ring-2 ring-primary' : 'shadow-surface-2',
      )}
    >
      {plan.highlighted && (
        <span className="-top-2.5 absolute left-6 inline-flex h-5 items-center rounded-full bg-primary px-2 font-medium text-caption text-primary-foreground">
          {m.pricing_page_recommended()}
        </span>
      )}
      <h3 className="font-semibold text-title">{plan.name}</h3>
      <div className="grid gap-0.5">
        <p className="flex items-baseline gap-1">
          <span className="font-semibold text-display">
            {price
              ? formatPrice(price.amount, price.currency, locale)
              : free
                ? formatPrice(0, 'usd', locale)
                : m.pricing_page_price_unavailable()}
          </span>
          {price && (
            <span className="text-muted-foreground">
              {interval === 'month' ? m.pricing_page_per_month() : m.pricing_page_per_year()}
            </span>
          )}
        </p>
        <p className="text-caption text-muted-foreground">
          {free
            ? m.pricing_page_note_free()
            : yearlyMonthly
              ? m.pricing_page_note_yearly({ price: yearlyMonthly })
              : price
                ? m.pricing_page_note_monthly()
                : ' '}
        </p>
      </div>
      <Button asChild variant={plan.highlighted ? 'default' : 'outline'}>
        {free ? (
          <Link to="/register">{m.pricing_page_start_free()}</Link>
        ) : (
          <Link to="/app">{m.pricing_page_subscribe({ name: plan.name })}</Link>
        )}
      </Button>
      <ul className="grid gap-2.5 border-t pt-4">
        {entitlements.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </li>
  )
}

function PackRow({ plan }: { plan: PricingPlan }) {
  const locale = getLocale()
  const price = planPrice(plan, 'month')
  return (
    <li className="flex items-center gap-3 rounded-xl bg-card px-5 py-4 shadow-surface-2">
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <h3 className="font-semibold text-subtitle">{plan.name}</h3>
          {plan.highlighted && (
            <span className="rounded-full bg-active px-2 text-caption">
              {m.pricing_page_popular()}
            </span>
          )}
        </span>
        <span className="text-caption text-muted-foreground">
          {m.pricing_page_pack_credits({ count: credits(plan.credits) })} ·{' '}
          {plan.creditExpiryDays === null
            ? m.pricing_page_pack_permanent()
            : m.pricing_page_pack_expiry({ count: plan.creditExpiryDays })}
        </span>
      </span>
      <span className="font-semibold text-title">
        {price
          ? formatPrice(price.amount, price.currency, locale)
          : m.pricing_page_price_unavailable()}
      </span>
      <Button asChild size="sm" variant="outline">
        <Link to="/app" aria-label={m.pricing_page_buy_label({ name: plan.name })}>
          {m.pricing_page_buy()}
        </Link>
      </Button>
    </li>
  )
}

function PricingEmpty() {
  return (
    <div className="grid justify-items-center gap-2.5 rounded-xl border border-dashed px-4 py-12 text-center">
      <span
        aria-hidden="true"
        className="flex h-20 w-30 items-center justify-center rounded-xl bg-active text-muted-foreground"
      >
        <CreditCard className="size-6" />
      </span>
      <h2 className="mt-1 font-semibold text-title">{m.pricing_page_empty_title()}</h2>
      <p className="max-w-md text-muted-foreground">{m.pricing_page_empty_desc()}</p>
      <Button asChild className="mt-1">
        <Link to="/register">{m.pricing_page_start_free()}</Link>
      </Button>
    </div>
  )
}

/** 加载态：保留分组骨架，避免数据到达后布局跳动 */
export function PricingSkeleton() {
  return (
    <div role="status" aria-label={m.pricing_page_loading()} className="grid gap-8 lg:grid-cols-10">
      <div className="grid gap-4 lg:col-span-7">
        <Bone className="h-8 w-40" />
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <div key={key} className="grid gap-4 rounded-xl bg-card p-6 shadow-surface-2">
              <Bone className="h-5 w-24" />
              <Bone className="h-8 w-30" />
              <Bone className="h-9 w-full" />
              <div className="grid gap-2.5 border-t pt-4">
                <Bone className="h-3 w-4/5" />
                <Bone className="h-3 w-2/3" />
                <Bone className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid content-start gap-3 lg:col-span-3">
        <Bone className="h-8 w-32" />
        {[0, 1, 2].map((key) => (
          <div
            key={key}
            className="flex items-center gap-3 rounded-xl bg-card px-5 py-4 shadow-surface-2"
          >
            <Bone className="h-4 flex-1" />
            <Bone className="h-5 w-14" />
          </div>
        ))}
      </div>
    </div>
  )
}

function Bone({ className }: { className: string }) {
  return <span className={cn('block animate-pulse rounded-md bg-active', className)} />
}

export function PricingError({ onRetry }: { onRetry(): void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{m.pricing_page_error_title()}</AlertTitle>
      <AlertDescription>
        <p>{m.pricing_page_error_desc()}</p>
        <Button type="button" size="sm" variant="outline" className="mt-1" onClick={onRetry}>
          {m.pricing_page_retry()}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function PricingFaq() {
  const questions = [
    { q: m.pricing_page_faq_1_q(), a: m.pricing_page_faq_1_a(), open: true },
    { q: m.pricing_page_faq_2_q(), a: m.pricing_page_faq_2_a(), open: true },
    { q: m.pricing_page_faq_3_q(), a: m.pricing_page_faq_3_a(), open: false },
    { q: m.pricing_page_faq_4_q(), a: m.pricing_page_faq_4_a(), open: false },
  ]
  return (
    <section aria-labelledby="pricing-faq" className="px-4 pb-20">
      <div className="mx-auto max-w-3xl">
        <h2 id="pricing-faq" className="text-center font-semibold text-display">
          {m.pricing_page_faq_title()}
        </h2>
        <div className="mt-6 divide-y border-y">
          {questions.map((item) => (
            <details key={item.q} open={item.open} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium marker:hidden">
                {item.q}
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                />
              </summary>
              <p className="pb-4 text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

export function PricingBody({ children }: { children: ReactNode }) {
  return (
    <section aria-label={m.pricing_page_plans_label()} className="px-4 pb-18">
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  )
}
