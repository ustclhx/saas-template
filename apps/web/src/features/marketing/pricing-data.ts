import type { PlanFeatures } from '@saas/db'
import type { customerCatalog } from '../billing/customer-data.ts'

export type BillingInterval = 'month' | 'year'

/**
 * 定价区块展示的套餐，字段对应 `plan` 与 `plan_price`（金额为最小货币单位）。
 * 首屏使用构建快照，浏览器经公开读取函数刷新；结账仍由服务端读取实时价格。
 */
export interface PricingPlan {
  readonly key: string
  readonly name: string
  readonly type: 'subscription' | 'credit_pack'
  readonly credits: number
  readonly creditExpiryDays: number | null
  readonly features: PlanFeatures
  readonly maxSeats: number | null
  readonly storageGb: number | null
  readonly highlighted?: boolean
  readonly prices: readonly {
    readonly interval: BillingInterval | null
    readonly amount: number
    readonly currency: string
  }[]
}

export type PricingCatalog = Awaited<ReturnType<typeof customerCatalog>>
export const PRICING_TTL_MS = 60 * 60 * 1000
/** 读取失败后的重试间隔：数据库短暂不可达时不应锁定一小时的降级数据 */
export const PRICING_RETRY_MS = 60 * 1000

/**
 * 只保存普通数据；Worker 的数据库客户端和 I/O Promise 不跨请求复用。
 * 读取失败时沿用上一次成功读取的数据（没有时才用构建快照），并在 `PRICING_RETRY_MS` 后重试。
 */
export function createPricingCache(snapshot: PricingCatalog, now = Date.now) {
  let catalog = snapshot
  let expiresAt = 0
  return async (read: () => Promise<PricingCatalog>): Promise<PricingCatalog> => {
    if (now() < expiresAt) return catalog
    try {
      catalog = await read()
      expiresAt = now() + PRICING_TTL_MS
    } catch {
      expiresAt = now() + PRICING_RETRY_MS
    }
    return catalog
  }
}

export function marketingPlans(catalog: PricingCatalog): PricingPlan[] {
  return catalog.plans.map((plan) => ({
    key: plan.key,
    name: plan.name,
    type: plan.type,
    credits: plan.credits,
    creditExpiryDays: plan.creditExpiryDays,
    features: plan.features,
    maxSeats: plan.features.maxSeats,
    storageGb: plan.features.storageGb,
    highlighted: plan.key === 'pro',
    prices: catalog.prices
      .filter((price) => price.planId === plan.id)
      .filter(
        (price, index, prices) =>
          prices.findIndex(
            (other) => other.interval === price.interval && other.currency === price.currency,
          ) === index,
      ),
  }))
}

export type PricingFeature =
  | { key: 'maxSeats' | 'storageGb' | 'maxConcurrentTasks'; value: number }
  | { key: 'publicApi' | 'priorityQueue' | 'watermark'; value: boolean }
  | { key: 'models'; value: readonly string[] }

/** Stable keys let each UI localize labels without hardcoding plan-specific promises. */
export function pricingFeatures(features: PlanFeatures): PricingFeature[] {
  return [
    { key: 'maxSeats', value: features.maxSeats },
    { key: 'storageGb', value: features.storageGb },
    { key: 'maxConcurrentTasks', value: features.maxConcurrentTasks },
    { key: 'publicApi', value: features.publicApi },
    { key: 'priorityQueue', value: features.priorityQueue },
    { key: 'watermark', value: features.watermark },
    { key: 'models', value: features.models },
  ]
}

export function groupPricingPlans<T extends { readonly type: 'subscription' | 'credit_pack' }>(
  plans: readonly T[],
) {
  return {
    subscriptions: plans.filter((plan) => plan.type === 'subscription'),
    creditPacks: plans.filter((plan) => plan.type === 'credit_pack'),
  }
}

export function pricingForInterval<P extends { readonly interval: BillingInterval | null }>(
  plan: { readonly type: 'subscription' | 'credit_pack'; readonly prices: readonly P[] },
  interval: BillingInterval,
): P[] {
  return plan.prices.filter(
    (price) => price.interval === (plan.type === 'subscription' ? interval : null),
  )
}
