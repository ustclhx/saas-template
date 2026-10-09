import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleFileDownload } from '../../../features/files/http.ts'
import { getAuth } from '../../../server/auth.ts'

export const Route = createFileRoute('/api/files/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        const db = createDb(env.HYPERDRIVE)
        return handleFileDownload(request, params.id, { db, auth: getAuth(env, db), env })
      },
    },
  },
})
