import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { createFileRoute } from '@tanstack/react-router'
import { handleSharedFileDownload } from '../../../../features/files/http.ts'

export const Route = createFileRoute('/api/files/shared/$token')({
  server: {
    handlers: {
      GET: ({ params }) =>
        handleSharedFileDownload(params.token, { db: createDb(env.HYPERDRIVE), env }),
    },
  },
})
