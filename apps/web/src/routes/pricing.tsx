import { Select, SelectContent, SelectItem, SelectTrigger } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound, Link } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { trackEvent } from '../features/analytics/track.ts'
import { MarketingShell } from '../features/marketing/marketing-shell.tsx'
import { getMarketingPricing } from '../features/marketing/pricing.functions.ts'
import { groupPricingPlans, PRICING_TTL_MS } from '../features/marketing/pricing-data.ts'
import { originFromMatches, pageHead, staticPage } from '../features/seo/metadata.ts'
import { pricingData } from '../features/seo/structured-data.ts'
import { m } from '../paraglide/messages.js'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'

export const Route = createFileRoute('/pricing')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  loader: () => getMarketingPricing(),
  component: PricingPage,
  head: ({ matches, loaderData }) =>
    pageHead(
      staticPage('/pricing', getLocale()),
      originFromMatches(matches),
      loaderData ? pricingData(loaderData, originFromMatches(matches), getLocale()) : [],
    ),
})
function PricingPage() {
  const initialCatalog = Route.useLoaderData()
  const [catalog, setCatalog] = useState(initialCatalog)
  const groups = groupPricingPlans(catalog.plans)
  const [ready, setReady] = useState(false)
  const [provider, setProvider] = useState(
    catalog.providers.find((p) => p.available)?.id ?? catalog.providers[0]?.id ?? '',
  )
  const providerId = useId()
  const currentProvider = catalog.providers.find((p) => p.id === provider)
  const providerLabel = (p: (typeof catalog.providers)[number]) =>
    p.available ? p.id : `${p.id} — unavailable`
  useEffect(() => setReady(true), [])
  useEffect(() => trackEvent('paywall_view'), [])
  useEffect(() => {
    setCatalog(initialCatalog)
    let active = true
    const timer = window.setInterval(async () => {
      try {
        const refreshed = await getMarketingPricing()
        if (active) setCatalog(refreshed)
      } catch {
        // 网络不可达时保留当前展示；结账入口始终重新读取服务端价格。
      }
    }, PRICING_TTL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [initialCatalog])
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-4xl gap-6 p-6">
        <h1 className="text-2xl font-semibold">Pricing</h1>
        <p>Choose a subscription or buy extra credits.</p>
        <p>{m.billing_coexist_order()}</p>
        <div>
          <label htmlFor={providerId}>Payment method</label>
          <Select
            value={currentProvider ? provider : ''}
            disabled={!ready}
            onValueChange={setProvider}
          >
            <SelectTrigger
              id={providerId}
              className="w-full"
              placeholder="Payment method"
              valueLabel={currentProvider ? providerLabel(currentProvider) : undefined}
            />
            <SelectContent>
              {catalog.providers.map((p, index) => (
                <SelectItem key={p.id} index={index} value={p.id} disabled={!p.available}>
                  {providerLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!catalog.providers.some((p) => p.available) && (
          <p role="status">Payments are currently unavailable. You can still explore the plans.</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {[...groups.subscriptions, ...groups.creditPacks].map((plan) => (
            <section key={plan.id} className="grid gap-3 rounded-xl border p-6">
              <h2 className="text-xl font-semibold">{plan.name}</h2>
              <p>
                {plan.credits} credits {plan.type === 'subscription' ? 'each month' : 'per pack'}
              </p>
              <p>
                {plan.features.maxSeats} seats · {plan.features.storageGb} GB storage
              </p>
              {plan.creditExpiryDays && <p>Credits expire after {plan.creditExpiryDays} days.</p>}
              {catalog.prices
                .filter((price) => price.planId === plan.id && price.provider === provider)
                .map((price) => (
                  <p key={price.id}>
                    {price.currency.toUpperCase() === 'USD'
                      ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        }).format(price.amount / 100)
                      : 'Price unavailable'}
                    {price.interval ? ` / ${price.interval}` : ''}
                    {price.available ? '' : ' · Payments unavailable'}
                  </p>
                ))}
              <Link to="/app" className="underline">
                View in my workspace
              </Link>
            </section>
          ))}
        </div>
      </div>
    </MarketingShell>
  )
}
