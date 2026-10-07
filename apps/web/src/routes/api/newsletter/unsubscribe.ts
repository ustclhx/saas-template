import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { newsletterLink } from '../../../features/growth/http.ts'

const handle = ({ request }: { request: Request }) => newsletterLink(request, env, 'unsubscribe')
export const Route = createFileRoute('/api/newsletter/unsubscribe')({
  server: { handlers: { GET: handle, POST: handle } },
})
