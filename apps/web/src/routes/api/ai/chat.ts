import { env, waitUntil } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleChatRequest } from '../../../features/ai/chat.ts'
import { getAuth } from '../../../server/auth.ts'

export const Route = createFileRoute('/api/ai/chat')({
  server: {
    handlers: {
      POST: ({ request }) => {
        const db = createDb(env.HYPERDRIVE)
        return handleChatRequest(request, {
          db,
          auth: getAuth(env, db),
          env,
          rateLimiter: env.RL_AI,
          waitUntil,
        })
      },
    },
  },
})
