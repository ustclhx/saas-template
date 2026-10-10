import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { AppError } from '@saas/shared'
import { createFileRoute } from '@tanstack/react-router'
import { apiError } from '../../../../features/api-keys/completions.ts'
import { handlePublicMediaDetail } from '../../../../features/api-keys/tasks.ts'
import { getAuth } from '../../../../server/auth.ts'
import { templateConfig } from '../../../../server/template-config.ts'

function deps() {
  const db = createDb(env.HYPERDRIVE)
  return {
    db,
    auth: getAuth(env, db),
    env,
    workflow: env.AI_MEDIA_WORKFLOW,
    config: templateConfig,
    rateLimiter: env.RL_API,
  }
}

const unsupported = () =>
  apiError(
    new AppError(
      templateConfig.features.publicApi ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      templateConfig.features.publicApi ? 'Use GET for media tasks' : 'Not found',
      { status: templateConfig.features.publicApi ? 405 : 404 },
    ),
  )

export const Route = createFileRoute('/api/v1/tasks/$taskId')({
  server: {
    handlers: {
      GET: ({ request, params }) => handlePublicMediaDetail(request, params.taskId, deps()),
      POST: unsupported,
      HEAD: unsupported,
      PUT: unsupported,
      PATCH: unsupported,
      DELETE: unsupported,
      OPTIONS: unsupported,
    },
  },
})
