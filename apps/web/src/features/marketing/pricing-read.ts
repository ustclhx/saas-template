import { createDb, type HyperdriveBinding, plan, planPrice } from '@saas/db'
import { log } from '@saas/shared/log'
import { asc, desc, eq } from 'drizzle-orm'
import type { PricingCatalog } from './pricing-data.ts'

/** 公开展示只保留有效价格；支付可用性由每次请求的运行时配置决定。 */
export async function readPricingCatalog(binding: HyperdriveBinding): Promise<PricingCatalog> {
  const db = createDb(binding)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Pricing database timeout')), 3000)
      }),
    ])
  } catch (error) {
    log.warn('pricing.database_unavailable', { error })
    throw error
  } finally {
    clearTimeout(timer)
    await db.$client.end({ timeout: 1 })
  }

  async function read(): Promise<PricingCatalog> {
    const plans = await db
      .select({
        id: plan.id,
        key: plan.key,
        name: plan.name,
        type: plan.type,
        credits: plan.credits,
        creditExpiryDays: plan.creditExpiryDays,
        features: plan.features,
      })
      .from(plan)
      .where(eq(plan.active, true))
      .orderBy(asc(plan.sort))
    const prices = await db
      .select()
      .from(planPrice)
      .where(eq(planPrice.active, true))
      .orderBy(desc(planPrice.createdAt), desc(planPrice.id))
    return {
      plans,
      prices: prices
        .filter((price) => plans.some((plan) => plan.id === price.planId))
        .map(({ providerPriceId, createdAt: _createdAt, updatedAt: _updatedAt, ...price }) => ({
          ...price,
          available:
            Boolean(providerPriceId) &&
            !providerPriceId.startsWith('unsynced:') &&
            price.currency.toUpperCase() === 'USD',
        })),
      providers: [],
    }
  }
}
