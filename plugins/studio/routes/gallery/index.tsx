import { createFileRoute } from '@tanstack/react-router'
import { originFromMatches } from '@web/features/seo/metadata.ts'
import { m } from '@web/paraglide/messages.js'
import { getLocale } from '@web/paraglide/runtime.js'
import { getGalleryPage } from '../../src/web/gallery/gallery.functions.ts'
import { GalleryErrorPage, GalleryPage } from '../../src/web/gallery/gallery-page.tsx'
import { galleryHead, noindexHead } from '../../src/web/gallery/gallery-seo.ts'
import { parseGallerySearch } from '../../src/web/gallery/paths.ts'

/** 公开画廊（openspec add-media-studio 6.1）：SSR、不预渲染，匿名响应走边缘缓存（page-cache.ts） */
export const Route = createFileRoute('/gallery/')({
  validateSearch: parseGallerySearch,
  server: {
    handlers: {
      GET: async ({ request, next }) =>
        (await import('../../src/web/gallery/document.server.ts')).handleStudioDocument({
          request,
          next,
          route: 'gallery',
        }),
    },
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getGalleryPage({ data: deps }),
  head: ({ matches, match, loaderData }) => {
    if (match.status === 'error') return noindexHead(m.studio_gallery_error_title())
    const search = match.search
    const page = search.page ?? 1
    return galleryHead({
      search,
      locale: getLocale(),
      // 多站点：绝对地址用作品所在站点的规范来源
      appUrl: loaderData?.origin ?? originFromMatches(matches),
      title: page > 1 ? m.studio_gallery_page_title({ page }) : m.studio_gallery_title(),
      description: m.studio_gallery_intro(),
    })
  },
  component: GalleryRoute,
  errorComponent: GalleryErrorPage,
})

function GalleryRoute() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  return <GalleryPage data={data} search={search} />
}
