import { createFileRoute } from '@tanstack/react-router'
import { handleMediaCancel } from '../../../../../features/ai/media-tasks.ts'
import { getAiHttpDeps } from '../../../../../features/ai/runtime.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks/$taskId/cancel')({
  server: {
    handlers: {
      POST: ({ request, params }) => handleMediaCancel(request, params.taskId, deps()),
    },
  },
})
