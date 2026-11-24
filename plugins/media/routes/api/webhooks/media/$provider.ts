import { getMediaProviderDefinition } from '@saas/ai'
import { createFileRoute } from '@tanstack/react-router'
import { getAiHttpDeps } from '@web/features/ai/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { handleMediaWebhook } from '../../../../src/web/media-tasks.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/webhooks/media/$provider')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        const definition = getMediaProviderDefinition(params.provider)
        if (!definition || definition.synchronous) return new Response(null, { status: 404 })
        return handleMediaWebhook(request, params.provider, deps())
      },
    },
  },
})
