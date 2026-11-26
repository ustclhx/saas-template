import { createFileRoute } from '@tanstack/react-router'

/** 画廊站点地图（openspec add-media-studio 6.4），由 robots.txt 列出；多于一片时为站点地图索引 */
export const Route = createFileRoute('/sitemap-gallery.xml')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import('../src/web/gallery/sitemap.server.ts')).gallerySitemapResponse(
          request,
          'root',
        ),
    },
  },
})
