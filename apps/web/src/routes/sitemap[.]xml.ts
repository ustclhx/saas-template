import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { sitemap } from '../features/seo/crawlers.ts'
import { getPublicPages } from '../features/seo/pages.server.ts'

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () =>
        new Response(sitemap(getPublicPages(), env.APP_URL), {
          headers: {
            'content-type': 'application/xml; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        }),
    },
  },
})
