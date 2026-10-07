import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { robots } from '../features/seo/crawlers.ts'

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response(robots(env.APP_URL), {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        }),
    },
  },
})
