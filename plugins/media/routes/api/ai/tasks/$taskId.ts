import { createFileRoute } from '@tanstack/react-router'
import { getAiHttpDeps } from '@web/features/ai/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { handleMediaDetail } from '../../../../src/web/media-tasks.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks/$taskId')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaDetail(request, params.taskId, deps())
      },
    },
  },
})
