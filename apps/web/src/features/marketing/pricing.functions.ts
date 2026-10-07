import { env } from 'cloudflare:workers'
import { createTestPaymentRuntime } from '@saas/billing'
import { createServerFn } from '@tanstack/react-start'
import { templateConfig } from '../../server/template-config.ts'
import { createPricingCache } from './pricing-data.ts'
import { readPricingCatalog } from './pricing-read.ts'
import { pricingSnapshot } from './pricing-snapshot.ts'

const readCached = createPricingCache(pricingSnapshot)

export const getMarketingPricing = createServerFn({ method: 'GET' }).handler(async () => {
  const catalog = await readCached(() => readPricingCatalog(env.HYPERDRIVE_CACHED))
  const providers = createTestPaymentRuntime(env, templateConfig.billing.providers, {
    cache: env.CACHE,
  }).readiness
  return {
    ...catalog,
    providers,
    prices: catalog.prices.map((price) => ({
      ...price,
      available: price.available && providers.some((p) => p.id === price.provider && p.available),
    })),
  }
})
