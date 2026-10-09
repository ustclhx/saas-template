import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleFileUpload } from '../../../features/files/http.ts'
import { getAuth } from '../../../server/auth.ts'

export const Route = createFileRoute('/api/files/uploads')({
  server: {
    handlers: {
      POST: ({ request }) => {
        const db = createDb(env.HYPERDRIVE)
        return handleFileUpload(request, { db, auth: getAuth(env, db), env })
      },
    },
  },
})
