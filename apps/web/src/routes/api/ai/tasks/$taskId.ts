import { createFileRoute } from '@tanstack/react-router'
import { handleMediaDetail } from '../../../../features/ai/media-tasks.ts'
import { getAiHttpDeps } from '../../../../features/ai/runtime.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks/$taskId')({
  server: {
    handlers: {
      GET: ({ request, params }) => handleMediaDetail(request, params.taskId, deps()),
    },
  },
})
