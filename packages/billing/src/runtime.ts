import type { TemplateConfig } from '@saas/config'
import { EnvValidationError } from '@saas/config'
import type { JsonValue, PaymentProviderId } from '@saas/db'
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

/** P2 uses test/sandbox only. Missing credentials leave checkout unavailable without breaking auth. */
export function createTestPaymentRuntime(
  env: PaymentRuntimeEnv,
  enabled: TemplateConfig['billing']['providers'],
  options: { fetch?: typeof fetch; cache?: PayPalTokenCache } = {},
) {
  const providers: BillingProviders = {}
  const normalizers: Partial<
    Record<PaymentProviderId, (payload: JsonValue) => Promise<VerifiedWebhook>>
  > = {}
  if (enabled.includes('stripe') && env.STRIPE_SECRET_KEY) {
    if (!env.STRIPE_SECRET_KEY.startsWith('sk_test_'))
      throw new EnvValidationError([], ['STRIPE_SECRET_KEY'])
    if (env.STRIPE_WEBHOOK_SECRET) {
      providers.stripe = createStripeProvider({
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        ...(options.fetch && { fetch: options.fetch }),
      })
      normalizers.stripe = createStripeWebhookNormalizer({
        secretKey: env.STRIPE_SECRET_KEY,
        ...(options.fetch && { fetch: options.fetch }),
      })
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
  }
  return {
    providers,
    normalizers,
    readiness: enabled.map((id) => ({ id, available: Boolean(providers[id]) })),
  }
}
