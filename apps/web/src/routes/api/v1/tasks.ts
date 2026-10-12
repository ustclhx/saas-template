import { AppError } from '@saas/shared'
import { createFileRoute } from '@tanstack/react-router'
import { getAiHttpDeps } from '../../../features/ai/runtime.ts'
import { apiError } from '../../../features/api-keys/completions.ts'
import { handlePublicMediaSubmit } from '../../../features/api-keys/tasks.ts'
import { templateConfig } from '../../../server/template-config.ts'

function deps() {
  return { ...getAiHttpDeps(), config: templateConfig }
}

const unsupported = () =>
  apiError(
    new AppError(
      templateConfig.features.publicApi ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      templateConfig.features.publicApi ? 'Use POST for media tasks' : 'Not found',
      { status: templateConfig.features.publicApi ? 405 : 404 },
    ),
  )

export const Route = createFileRoute('/api/v1/tasks')({
  server: {
    handlers: {
      POST: ({ request }) => handlePublicMediaSubmit(request, deps()),
      GET: unsupported,
      HEAD: unsupported,
      PUT: unsupported,
      PATCH: unsupported,
      DELETE: unsupported,
      OPTIONS: unsupported,
    },
  },
})
