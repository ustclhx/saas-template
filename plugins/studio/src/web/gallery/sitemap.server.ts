// 画廊站点地图 /sitemap-gallery.xml（design 决策 10）：只列本站审核通过的作品页（发布时间倒序，单文件 5 万条，
// 超出时 /sitemap-gallery-<n>.xml，最多 10 片）。第一片的首条是画廊列表页 /gallery（各语言），主站点地图不含它，两者不重叠。

import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { escapeXml } from '@web/features/seo/crawlers.ts'
import { absoluteUrl, localizedPath } from '@web/features/seo/metadata.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { enabledStudioKinds } from '../../kinds.ts'
import { listPublicSitemapWorks } from '../public-works.ts'
import { studioUnavailable } from './document.server.ts'
import { finishPublicResponse } from './page-cache.ts'
import { workPath } from './paths.ts'
import { studioPublicSite } from './site.server.ts'

const locales = templateConfig.i18n.enabled
  ? templateConfig.i18n.locales
  : [templateConfig.i18n.defaultLocale]

export function gallerySitemapXml(input: {
  origin: string
  page: number
  works: readonly { slug: string; lastmod: Date }[]
}): string {
  const entries = [
    ...(input.page === 1
      ? locales.map(
          (locale) =>
            `<url><loc>${escapeXml(absoluteUrl(input.origin, localizedPath('/gallery', locale)))}</loc></url>`,
        )
      : []),
    ...input.works.map(
      (work) =>
        `<url><loc>${escapeXml(absoluteUrl(input.origin, workPath(work.slug)))}</loc><lastmod>${work.lastmod.toISOString()}</lastmod></url>`,
    ),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>`
}

function plain(status: number) {
  return new Response(status === 404 ? 'Not found' : 'Service unavailable', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export async function gallerySitemapResponse(request: Request, page: number): Promise<Response> {
  const runtime = getWebRuntime()
  if (pluginUnavailable(runtime, 'studio')) return studioUnavailable()
  const kinds = enabledStudioKinds(templateConfig)
  const site = studioPublicSite(request.url)
  const finish = (response: Response, failed = false) =>
    finishPublicResponse({ request, response, route: 'sitemap', failed, runtime })
  if (!site || kinds.length === 0) return finish(plain(404))
  try {
    const { works } = await listPublicSitemapWorks(runtime.publicDb, {
      site: site.key,
      kinds,
      page,
    })
    return finish(
      new Response(gallerySitemapXml({ origin: site.origin, page, works }), {
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      }),
    )
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return finish(plain(404))
    log.error('studio.sitemap.load_failed', { error })
    return finish(plain(503), true)
  }
}
