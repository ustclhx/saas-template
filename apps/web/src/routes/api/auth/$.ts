import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { handleAuthRequest } from '../../../features/admin/impersonation-http.ts'

// Better Auth 的全部接口（basePath /api/auth）
const handle = ({ request }: { request: Request }) => handleAuthRequest(request, env)

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: { GET: handle, POST: handle },
  },
})
