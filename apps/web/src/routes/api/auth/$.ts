import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { getAuth } from '../../../server/auth.ts'

// Better Auth 的全部接口（basePath /api/auth）
const handle = ({ request }: { request: Request }) => getAuth(env).handler(request)

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: { GET: handle, POST: handle },
  },
})
