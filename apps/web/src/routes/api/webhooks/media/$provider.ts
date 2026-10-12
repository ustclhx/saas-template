import { getMediaProviderDefinition } from '@saas/ai'
import { createFileRoute } from '@tanstack/react-router'
import { handleMediaWebhook } from '../../../../features/ai/media-tasks.ts'
import { getAiHttpDeps } from '../../../../features/ai/runtime.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/webhooks/media/$provider')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        const definition = getMediaProviderDefinition(params.provider)
        if (!definition || definition.synchronous) return new Response(null, { status: 404 })
        return handleMediaWebhook(request, params.provider, deps())
      },
    },
  },
})
