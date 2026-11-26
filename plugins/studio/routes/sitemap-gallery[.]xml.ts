import { createFileRoute } from '@tanstack/react-router'

/** 画廊站点地图第一片（openspec add-media-studio 6.4），由 robots.txt 列出 */
export const Route = createFileRoute('/sitemap-gallery.xml')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import('../src/web/gallery/sitemap.server.ts')).gallerySitemapResponse(request, 1),
    },
  },
})
