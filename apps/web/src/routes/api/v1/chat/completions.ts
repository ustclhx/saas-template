import { env, waitUntil } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { AppError } from '@saas/shared'
import { createFileRoute } from '@tanstack/react-router'
import { apiError, handleCompletions } from '../../../../features/api-keys/completions.ts'
import { getAuth } from '../../../../server/auth.ts'
import { templateConfig } from '../../../../server/template-config.ts'

const unsupported = () =>
  apiError(
    new AppError(
      templateConfig.features.publicApi ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      templateConfig.features.publicApi ? 'Use POST for chat completions' : 'Not found',
      { status: templateConfig.features.publicApi ? 405 : 404 },
    ),
  )

export const Route = createFileRoute('/api/v1/chat/completions')({
  server: {
    handlers: {
      GET: unsupported,
      HEAD: unsupported,
      PUT: unsupported,
      PATCH: unsupported,
      DELETE: unsupported,
      OPTIONS: unsupported,
      POST: ({ request }) => {
        const db = createDb(env.HYPERDRIVE)
        return handleCompletions(request, {
          db,
          auth: getAuth(env, db),
          env,
          waitUntil,
          config: templateConfig,
          rateLimiter: env.RL_API,
        })
      },
    },
  },
})
