import { describe, expect, it, vi } from 'vitest'
import { examplePricingCatalog } from '../../../scripts/pricing-snapshot.ts'
import { createPricingCache, marketingPlans, PRICING_TTL_MS } from './pricing-data.ts'

describe('公开定价缓存（tasks.md 3.2）', () => {
  it('一小时内复用读取结果，到期后展示更新的价格', async () => {
    const snapshot = examplePricingCatalog()
    let now = 1000
    let amount = 1900
    const read = vi.fn(async () => ({
      ...snapshot,
      prices: snapshot.prices.map((price) => ({ ...price, amount })),
    }))
    const cached = createPricingCache(snapshot, () => now)
    expect((await cached(read)).prices[0]?.amount).toBe(1900)
    amount = 2900
    now += PRICING_TTL_MS - 1
    expect((await cached(read)).prices[0]?.amount).toBe(1900)
    expect(read).toHaveBeenCalledTimes(1)
    now++
    expect((await cached(read)).prices[0]?.amount).toBe(2900)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('初次读取或刷新时数据库不可达，返回构建数据并在下一周期恢复', async () => {
    const snapshot = examplePricingCatalog()
    let now = 1000
    const cached = createPricingCache(snapshot, () => now)
    const offline = vi.fn(async () => {
      throw new Error('Database unavailable')
    })
    expect(await cached(offline)).toBe(snapshot)
    await cached(offline)
    expect(offline).toHaveBeenCalledTimes(1)
    const live = { ...snapshot, prices: snapshot.prices.map((p) => ({ ...p, amount: 4900 })) }
    now += PRICING_TTL_MS
    expect(await cached(async () => live)).toBe(live)
    now += PRICING_TTL_MS
    expect(await cached(offline)).toBe(snapshot)
  })

  it('区块展示套餐的积分、权益与价格，并合并不同支付渠道的同周期报价', () => {
    const plans = marketingPlans(examplePricingCatalog())
    const pro = plans.find((plan) => plan.key === 'pro')
    expect(pro).toMatchObject({ credits: 1000, maxSeats: 1, storageGb: 50 })
    expect(pro?.prices.map((p) => [p.interval, p.amount])).toEqual([
      ['month', 1900],
      ['year', 19000],
    ])
  })
})
