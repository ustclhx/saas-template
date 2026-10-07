import type { PricingPlan } from './sections/pricing.tsx'

/**
 * 定价区块的静态占位数据，与 @saas/billing 的模板示例套餐（catalog.ts）一致。
 * tasks.md 3.2 改为构建期读取 `plan` / `plan_price` 并按 1 小时缓存刷新，届时把查询结果映射为
 * `PricingPlan[]` 传给 `<Pricing plans={...} />` 即可，组件本身不需要修改。
 */
export const placeholderPlans: PricingPlan[] = [
  {
    key: 'free',
    name: 'Free',
    type: 'subscription',
    credits: 0,
    creditExpiryDays: null,
    maxSeats: 1,
    storageGb: 5,
    prices: [],
  },
  {
    key: 'pro',
    name: 'Pro',
    type: 'subscription',
    credits: 1000,
    creditExpiryDays: null,
    maxSeats: 1,
    storageGb: 50,
    highlighted: true,
    prices: [
      { interval: 'month', amount: 1900, currency: 'usd' },
      { interval: 'year', amount: 19000, currency: 'usd' },
    ],
  },
  {
    key: 'team',
    name: 'Team',
    type: 'subscription',
    credits: 5000,
    creditExpiryDays: null,
    maxSeats: 10,
    storageGb: 200,
    prices: [
      { interval: 'month', amount: 4900, currency: 'usd' },
      { interval: 'year', amount: 49000, currency: 'usd' },
    ],
  },
  {
    key: 'credit_pack',
    name: 'Credit pack',
    type: 'credit_pack',
    credits: 1000,
    creditExpiryDays: 365,
    maxSeats: null,
    storageGb: null,
    prices: [{ interval: null, amount: 1000, currency: 'usd' }],
  },
]
