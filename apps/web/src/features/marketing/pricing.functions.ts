import { createServerFn } from '@tanstack/react-start'
import { getWebRuntime } from '../../server/runtime.ts'

export const getMarketingPricing = createServerFn({ method: 'GET' }).handler(async () => {
  const { readMarketingPricing } = await import('./pricing.server.ts')
  return readMarketingPricing(getWebRuntime())
})
