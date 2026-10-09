import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleFileComplete } from '../../../features/files/http.ts'
import { getAuth } from '../../../server/auth.ts'

export const Route = createFileRoute('/api/files/$id/complete')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        const db = createDb(env.HYPERDRIVE)
        return handleFileComplete(request, params.id, { db, auth: getAuth(env, db), env })
      },
    },
  },
})
