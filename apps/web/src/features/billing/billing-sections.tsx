import { Alert, AlertDescription, AlertTitle, Badge, type BadgeColor, Button, cn } from '@saas/ui'
import { CircleAlert } from '@saas/ui/icons'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import type { DailyCreditsCheck } from '../credits/daily.server.ts'

/** 账单页积分摘要，字段与 `getCreditSummary` 一致 */
export interface BillingCreditSummary {
  readonly subscription: { readonly total: number; readonly currentPeriod: number }
  readonly purchase: number
  readonly free: { readonly signup: number; readonly daily: number; readonly total: number }
  readonly other: number
  readonly available: number
}

export interface BillingSections {
  readonly subscription: boolean
  readonly packs: boolean
  readonly free: boolean
}

/**
 * 「订阅 / 积分包 / 免费积分」三个分区各自有数据来源时才渲染：
 * 订阅来自有价格的订阅套餐或已有订阅，积分包来自积分包套餐或已持有的积分包积分，
 * 免费积分来自注册赠送 / 每日领取配置或已持有的免费积分。
 */
export function billingSections({
  plans,
  prices,
  subscriptionCount,
  summary,
  freeConfigured,
}: {
  plans: readonly { readonly id: string; readonly type: 'subscription' | 'credit_pack' }[]
  prices: readonly { readonly planId: string }[]
  subscriptionCount: number
  summary: BillingCreditSummary | null
  freeConfigured: boolean
}): BillingSections {
  const priced = (type: 'subscription' | 'credit_pack') =>
    plans.some((plan) => plan.type === type && prices.some((price) => price.planId === plan.id))
  return {
    subscription: priced('subscription') || subscriptionCount > 0,
    packs: priced('credit_pack') || (summary?.purchase ?? 0) > 0,
    free: freeConfigured || (summary?.free.total ?? 0) > 0,
  }
}

export const formatCredits = (count: number) => new Intl.NumberFormat(getLocale()).format(count)

export const formatBillingDate = (value: Date | string | null) =>
  value
    ? new Date(value).toLocaleDateString(getLocale(), { timeZone: 'UTC', dateStyle: 'medium' })
    : m.billing_page_pending()

/** 分区外框：标题在左，补充信息在右 */
export function BillingSection({
  id,
  title,
  aside,
  children,
}: {
  id: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid scroll-mt-6 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={`${id}-title`} className="font-semibold text-title">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function BillingCard({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.ComponentProps<'div'>) {
  return (
    <div className={cn('grid gap-2.5 rounded-xl border bg-card px-5 py-4', className)} {...props}>
      {children}
    </div>
  )
}

type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'ending' | 'ended'

export function subscriptionStatus(sub: {
  status: string
  cancelAtPeriodEnd: boolean
}): SubscriptionStatus {
  if (['canceled', 'expired'].includes(sub.status)) return 'ended'
  if (sub.cancelAtPeriodEnd) return 'ending'
  if (sub.status === 'trialing' || sub.status === 'past_due' || sub.status === 'paused')
    return sub.status
  return 'active'
}

const statusBadge: Record<SubscriptionStatus, { color: BadgeColor; label: () => string }> = {
  active: { color: 'green', label: m.billing_page_status_active },
  trialing: { color: 'blue', label: m.billing_page_status_trialing },
  past_due: { color: 'amber', label: m.billing_page_status_past_due },
  paused: { color: 'gray', label: m.billing_page_status_paused },
  ending: { color: 'amber', label: m.billing_page_status_ending },
  ended: { color: 'gray', label: m.billing_page_status_ended },
}

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  const badge = statusBadge[status]
  return <Badge color={badge.color}>{badge.label()}</Badge>
}

/** 未订阅时的订阅分区卡片 */
export function FreePlanCard({ action }: { action?: ReactNode }) {
  return (
    <BillingCard className="px-6 py-5 shadow-surface-2 sm:flex sm:items-center sm:justify-between sm:gap-6">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-semibold text-title">{m.billing_page_free_plan()}</h4>
          <Badge variant="dot">{m.billing_page_not_subscribed()}</Badge>
        </div>
        <p className="text-muted-foreground">{m.billing_page_free_desc()}</p>
      </div>
      {action}
    </BillingCard>
  )
}

export function DailyStatusBadge({ result }: { result: DailyCreditsCheck | null | undefined }) {
  if (result?.status === 'granted' || result?.status === 'already_claimed')
    return <Badge color="green">{m.billing_page_daily_claimed()}</Badge>
  if (result?.status === 'monthly_limit')
    return <Badge variant="dot">{m.billing_page_daily_limit()}</Badge>
  if (result?.status === 'unverified')
    return <Badge variant="dot">{m.billing_page_daily_verify()}</Badge>
  return null
}

/** 积分余额：订阅、积分包、免费积分三张卡片只渲染有数据来源的分区 */
export function CreditBalance({
  summary,
  sections,
  planCredits,
  renewalAt,
  packExpiry,
  daily,
  packAction,
  footer,
}: {
  summary: BillingCreditSummary
  sections: BillingSections
  /** 当前订阅套餐每期发放的积分，用于进度条；未订阅时为 null */
  planCredits: number | null
  renewalAt: Date | string | null
  /** 积分包有效天数；全部长期有效时为 null */
  packExpiry: number | null
  daily: DailyCreditsCheck | null | undefined
  packAction?: ReactNode
  footer?: ReactNode
}) {
  const percent =
    planCredits && planCredits > 0
      ? Math.min(100, Math.round((summary.subscription.currentPeriod / planCredits) * 100))
      : 0
  return (
    <BillingSection
      id="balance"
      title={m.billing_page_balance()}
      aside={
        <p className="text-muted-foreground">
          {m.billing_page_available()}{' '}
          <strong className="font-semibold text-foreground tabular-nums">
            {formatCredits(summary.available)}
          </strong>
        </p>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        {sections.subscription && (
          <BillingCard>
            <CardHead
              title={m.billing_page_sub_credits()}
              aside={
                renewalAt ? (
                  <span className="text-caption text-muted-foreground">
                    {m.billing_page_sub_resets({ date: formatBillingDate(renewalAt) })}
                  </span>
                ) : (
                  <span className="text-caption text-muted-foreground">
                    {m.billing_page_not_subscribed()}
                  </span>
                )
              }
            />
            <p className="font-semibold text-display tabular-nums">
              {formatCredits(summary.subscription.currentPeriod)}
              {planCredits ? (
                <span className="font-medium text-muted-foreground text-subtitle">
                  {' '}
                  / {formatCredits(planCredits)}
                </span>
              ) : null}
            </p>
            <div
              role="progressbar"
              aria-label={m.billing_page_sub_progress()}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 overflow-hidden rounded-full bg-active"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-caption text-muted-foreground">
              {summary.subscription.total > summary.subscription.currentPeriod
                ? m.billing_page_sub_total({ count: formatCredits(summary.subscription.total) })
                : m.billing_page_sub_no_rollover()}
            </p>
          </BillingCard>
        )}
        {sections.packs && (
          <BillingCard>
            <CardHead
              title={m.billing_page_pack_credits()}
              aside={
                <span className="text-caption text-muted-foreground">
                  {packExpiry === null
                    ? m.billing_page_pack_permanent()
                    : m.billing_page_pack_expiry({ count: packExpiry })}
                </span>
              }
            />
            <p className="font-semibold text-display tabular-nums">
              {formatCredits(summary.purchase)}
            </p>
            {summary.purchase === 0 && (
              <p className="text-caption text-muted-foreground">{m.billing_page_pack_empty()}</p>
            )}
            {packAction}
          </BillingCard>
        )}
        {sections.free && (
          <BillingCard>
            <CardHead
              title={m.billing_page_free_credits()}
              aside={<DailyStatusBadge result={daily} />}
            />
            <p className="font-semibold text-display tabular-nums">
              {formatCredits(summary.free.total)}
            </p>
            <dl className="grid gap-1 text-caption">
              <Row label={m.billing_page_signup()} value={formatCredits(summary.free.signup)} />
              <Row label={m.billing_page_daily()} value={formatCredits(summary.free.daily)} />
              {daily?.status === 'granted' && (
                <Row
                  label={m.billing_page_days_this_month()}
                  value={m.billing_page_days_value({
                    days: daily.daysThisMonth,
                    max: daily.maxDaysPerMonth,
                  })}
                />
              )}
            </dl>
          </BillingCard>
        )}
      </div>
      {summary.other > 0 && (
        <p className="text-caption text-muted-foreground">
          {m.billing_page_other_credits({ count: formatCredits(summary.other) })}
        </p>
      )}
      {footer}
    </BillingSection>
  )
}

function CardHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="font-medium">{title}</h4>
      {aside}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

/** 积分包购买卡片：价格随所选支付方式变化，不受订阅周期影响 */
export function PackOption({
  name,
  credits,
  price,
  expiry,
  highlighted,
  disabled,
  onBuy,
}: {
  name: string
  credits: number
  price: string
  expiry: string
  highlighted?: boolean
  disabled: boolean
  onBuy(): void
}) {
  return (
    <li
      className={cn(
        'grid gap-2 rounded-lg px-3.5 py-3 ring-1',
        highlighted ? 'ring-primary' : 'ring-border',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-semibold text-subtitle">{name}</span>
        <span className="text-caption text-muted-foreground tabular-nums">
          {m.billing_page_pack_amount({ count: formatCredits(credits) })}
        </span>
      </span>
      <span className="text-caption text-muted-foreground">
        {price} · {expiry}
      </span>
      <Button
        type="button"
        size="sm"
        variant={highlighted ? 'default' : 'outline'}
        disabled={disabled}
        aria-label={m.billing_page_buy_label({ name })}
        onClick={onBuy}
      >
        {m.billing_page_buy()}
      </Button>
    </li>
  )
}

export function BillingSkeleton() {
  return (
    <div role="status" aria-label={m.billing_page_loading()} className="grid gap-8">
      <div className="grid gap-2">
        <Bone className="h-7 w-48" />
        <Bone className="h-4 w-full max-w-lg" />
      </div>
      <BillingCard className="px-6 py-5">
        <Bone className="h-5 w-40" />
        <Bone className="h-3 w-full max-w-sm" />
      </BillingCard>
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <BillingCard key={key}>
            <Bone className="h-4 w-28" />
            <Bone className="h-7 w-24" />
            <Bone className="h-3 w-3/4" />
          </BillingCard>
        ))}
      </div>
    </div>
  )
}

function Bone({ className }: { className: string }) {
  return <span className={cn('block animate-pulse rounded-md bg-active', className)} />
}

export function BillingError({ onRetry }: { onRetry(): void }) {
  return (
    <div className="grid gap-6">
      <h2 className="font-semibold text-display">{m.billing_page_title()}</h2>
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>{m.billing_page_error_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.billing_page_error_desc()}</p>
          <Button type="button" size="sm" variant="outline" className="mt-1" onClick={onRetry}>
            {m.billing_page_retry()}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}
