import { createFileRoute } from '@tanstack/react-router'
import { getAiHttpDeps } from '@web/features/ai/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { handleMediaList, handleMediaSubmit } from '../../../src/web/media-tasks.ts'
import { getFileMediaHttpDeps } from '../../../src/web/runtime.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks')({
  server: {
    handlers: {
      POST: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaSubmit(request, getFileMediaHttpDeps())
      },
      GET: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaList(request, deps())
      },
    },
  },
})
