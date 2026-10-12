import { createFileRoute } from '@tanstack/react-router'
import { handleChatRequest } from '../../../features/ai/chat.ts'
import { getAiHttpDeps } from '../../../features/ai/runtime.ts'

export const Route = createFileRoute('/api/ai/chat')({
  server: {
    handlers: {
      POST: ({ request }) => {
        return handleChatRequest(request, getAiHttpDeps())
      },
    },
  },
})
