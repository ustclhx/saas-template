import type { PaymentProvider } from '../provider.ts'
import { createPayPalOperations } from './operations.ts'
import { createPayPalSnapshots } from './snapshots.ts'
import { createPayPalTransport, type PayPalTransportOptions } from './transport.ts'
import { payPalWebhookNormalizer, verifyPayPalWebhook } from './webhooks.ts'

export interface PayPalProviderOptions extends PayPalTransportOptions {
  webhookId?: string
}

/** Offline-testable composition; construction performs no platform I/O. */
export function createPayPalProvider(options: PayPalProviderOptions): PaymentProvider {
  const transport = createPayPalTransport(options)
  const normalize = payPalWebhookNormalizer(transport, options.environment)
  return {
    id: 'paypal',
    capabilities: {
      portal: false,
      changePlan: false,
      refundsViaApi: true,
      merchantOfRecord: false,
    },
    ...createPayPalOperations(transport),
    ...createPayPalSnapshots(transport),
    verifyWebhook: (req, rawBody) =>
      verifyPayPalWebhook(transport, req, rawBody, options.webhookId, normalize),
  }
}
export type { PayPalTokenCache } from './transport.ts'
export { createPayPalWebhookNormalizer } from './webhooks.ts'
