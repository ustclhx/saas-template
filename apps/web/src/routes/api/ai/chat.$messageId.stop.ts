import { createFileRoute } from '@tanstack/react-router'
import { handleChatStopRequest } from '../../../features/ai/chat.ts'
import { getWebRuntime } from '../../../server/runtime.ts'

export const Route = createFileRoute('/api/ai/chat/$messageId/stop')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        const { db, auth } = getWebRuntime()
        return handleChatStopRequest(request, params.messageId, { db, auth })
      },
    },
  },
})
