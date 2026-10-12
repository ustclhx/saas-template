import { createFileRoute } from '@tanstack/react-router'
import { handleMediaList, handleMediaSubmit } from '../../../features/ai/media-tasks.ts'
import { getAiHttpDeps } from '../../../features/ai/runtime.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks')({
  server: {
    handlers: {
      POST: ({ request }) => handleMediaSubmit(request, deps()),
      GET: ({ request }) => handleMediaList(request, deps()),
    },
  },
})
