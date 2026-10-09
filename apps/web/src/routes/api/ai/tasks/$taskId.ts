import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleMediaDetail } from '../../../../features/ai/media-tasks.ts'
import { getAuth } from '../../../../server/auth.ts'

function deps() {
  const db = createDb(env.HYPERDRIVE)
  return {
    db,
    auth: getAuth(env, db),
    env,
    workflow: env.AI_MEDIA_WORKFLOW,
    rateLimiter: env.RL_AI,
  }
}

export const Route = createFileRoute('/api/ai/tasks/$taskId')({
  server: {
    handlers: {
      GET: ({ request, params }) => handleMediaDetail(request, params.taskId, deps()),
    },
  },
})
