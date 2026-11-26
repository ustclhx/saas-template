import { createFileRoute } from '@tanstack/react-router'

/** 画廊站点地图第 2–10 片；第一片只用 /sitemap-gallery.xml，-1 与非数字返回 404 */
export const Route = createFileRoute('/sitemap-gallery-{$page}.xml')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const page = /^[1-9]\d?$/.test(params.page) ? Number(params.page) : 0
        if (page < 2) return new Response('Not found', { status: 404 })
        return (await import('../src/web/gallery/sitemap.server.ts')).gallerySitemapResponse(
          request,
          page,
        )
      },
    },
  },
})
