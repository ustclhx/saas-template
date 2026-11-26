import { createFileRoute } from '@tanstack/react-router'

/** 画廊站点地图分片 1–10：只在作品多于一片时存在，由 /sitemap-gallery.xml 索引列出 */
export const Route = createFileRoute('/sitemap-gallery-{$page}.xml')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const page = /^[1-9]\d?$/.test(params.page) ? Number(params.page) : 0
        if (page < 1 || page > 10) return new Response('Not found', { status: 404 })
        return (await import('../src/web/gallery/sitemap.server.ts')).gallerySitemapResponse(
          request,
          page,
        )
      },
    },
  },
})
