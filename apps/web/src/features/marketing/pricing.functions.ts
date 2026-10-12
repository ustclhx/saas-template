import { env } from 'cloudflare:workers'
import { createPaymentRuntime } from '@saas/billing'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { templateConfig } from '../../server/template-config.ts'
import { createPricingCache } from './pricing-data.ts'
import { readPricingCatalog } from './pricing-read.ts'
import { pricingSnapshot } from './pricing-snapshot.ts'

const readCached = createPricingCache(pricingSnapshot)

export const getMarketingPricing = createServerFn({ method: 'GET' }).handler(async () => {
  const catalog = await readCached(() => readPricingCatalog(env.HYPERDRIVE_CACHED))
  let providers: ReturnType<typeof createPaymentRuntime>['readiness']
  try {
    providers = createPaymentRuntime(env, templateConfig.billing.providers, {
      cache: env.CACHE,
    }).readiness
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 503) throw error
    // 公开页面保留定价内容，支付配置错误时关闭全部购买入口。
    providers = templateConfig.billing.providers.map((id) => ({ id, available: false }))
  }
  return {
    ...catalog,
    providers,
    prices: catalog.prices.map((price) => ({
      ...price,
      available: price.available && providers.some((p) => p.id === price.provider && p.available),
    })),
  }
})
