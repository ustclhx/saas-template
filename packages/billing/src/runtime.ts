import type { TemplateConfig } from '@saas/config'
import { EnvValidationError } from '@saas/config'
import type { JsonValue, PaymentProviderId } from '@saas/db'
import { log } from '@saas/shared/log'
import type { BillingProviders } from './events.ts'
import {
  createPayPalProvider,
  createPayPalWebhookNormalizer,
  type PayPalTokenCache,
} from './paypal/index.ts'
import type { VerifiedWebhook } from './provider.ts'
import { createStripeProvider, createStripeWebhookNormalizer } from './stripe/adapter.ts'

export interface PaymentRuntimeEnv {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  PAYPAL_CLIENT_ID?: string
  PAYPAL_CLIENT_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
}

// 同一 isolate 的多个入口共用告警状态，避免每次请求或 Cron 都重复记录。
const warnedProviders = new Set<PaymentProviderId>()

/** P2 uses test/sandbox only. Missing credentials leave checkout unavailable without breaking auth. */
export function createTestPaymentRuntime(
  env: PaymentRuntimeEnv,
  enabled: TemplateConfig['billing']['providers'],
  options: {
    fetch?: typeof fetch
    cache?: PayPalTokenCache
    warn?: (provider: PaymentProviderId, missing: (keyof PaymentRuntimeEnv)[]) => void
  } = {},
) {
  function warnUnconfigured(provider: PaymentProviderId, required: (keyof PaymentRuntimeEnv)[]) {
    if (warnedProviders.has(provider)) return
    const missing = required.filter((key) => !env[key])
    warnedProviders.add(provider)
    if (options.warn) options.warn(provider, missing)
    else log.warn('billing.provider_unconfigured', { provider, missing })
  }

  const providers: BillingProviders = {}
  const normalizers: Partial<
    Record<PaymentProviderId, (payload: JsonValue) => Promise<VerifiedWebhook>>
  > = {}
  if (enabled.includes('stripe')) {
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith('sk_test_'))
      throw new EnvValidationError([], ['STRIPE_SECRET_KEY'])
    if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
      providers.stripe = createStripeProvider({
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        ...(options.fetch && { fetch: options.fetch }),
      })
      normalizers.stripe = createStripeWebhookNormalizer({
        secretKey: env.STRIPE_SECRET_KEY,
        ...(options.fetch && { fetch: options.fetch }),
      })
    } else {
      warnUnconfigured('stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
    }
  }
  if (
    enabled.includes('paypal') &&
    env.PAYPAL_CLIENT_ID &&
    env.PAYPAL_CLIENT_SECRET &&
    env.PAYPAL_WEBHOOK_ID
  ) {
    if (!options.cache) throw new EnvValidationError([], ['CACHE'])
    const paypal = {
      environment: 'sandbox' as const,
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      fetch: options.fetch ?? fetch,
      cache: options.cache,
    }
    providers.paypal = createPayPalProvider(paypal)
    normalizers.paypal = createPayPalWebhookNormalizer(paypal)
  } else if (enabled.includes('paypal')) {
    warnUnconfigured('paypal', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'])
  }
  return {
    providers,
    normalizers,
    readiness: enabled.map((id) => ({ id, available: Boolean(providers[id]) })),
  }
}
