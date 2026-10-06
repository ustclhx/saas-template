import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleChatStopRequest } from '../../../features/ai/chat.ts'
import { getAuth } from '../../../server/auth.ts'

export const Route = createFileRoute('/api/ai/chat/$messageId/stop')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        const db = createDb(env.HYPERDRIVE)
        return handleChatStopRequest(request, params.messageId, { db, auth: getAuth(env, db) })
      },
    },
  },
})
