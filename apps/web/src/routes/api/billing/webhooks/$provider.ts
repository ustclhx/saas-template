import { env } from 'cloudflare:workers'
import { createTestPaymentRuntime } from '@saas/billing'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleBillingWebhook } from '../../../../features/billing/webhook-http.ts'
import { templateConfig } from '../../../../server/template-config.ts'

export const Route = createFileRoute('/api/billing/webhooks/$provider')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        const runtime = createTestPaymentRuntime(env, templateConfig.billing.providers, {
          cache: env.CACHE,
        })
        return handleBillingWebhook(request, params.provider, {
          db: createDb(env.HYPERDRIVE),
          providers: runtime.providers,
          queue: env.EVENTS_QUEUE,
          subscriptionCreditGraceHours: templateConfig.billing.subscriptionCreditGraceHours,
        })
      },
    },
  },
})
