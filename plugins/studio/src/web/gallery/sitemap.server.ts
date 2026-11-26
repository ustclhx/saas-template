// 画廊站点地图 /sitemap-gallery.xml（design 决策 10）：只列本站审核通过的作品页（发布时间倒序，每片 4.9 万件，
// 超出时 /sitemap-gallery.xml 改为索引，指向 /sitemap-gallery-<n>.xml，最多 10 片）。第一片的首条是画廊列表页 /gallery（各语言），主站点地图不含它，两者不重叠。

import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { escapeXml } from '@web/features/seo/crawlers.ts'
import { absoluteUrl, localizedPath } from '@web/features/seo/metadata.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { enabledStudioKinds } from '../../kinds.ts'
import {
  countPublicSitemapWorks,
  LAST_SITEMAP_PAGE,
  listPublicSitemapWorks,
  SITEMAP_PAGE_SIZE,
} from '../public-works.ts'
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

export function gallerySitemapIndexXml(origin: string, shards: number): string {
  const entries = Array.from(
    { length: shards },
    (_, index) =>
      `<sitemap><loc>${escapeXml(absoluteUrl(origin, `/sitemap-gallery-${index + 1}.xml`))}</loc></sitemap>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</sitemapindex>`
}

/** 审核通过的作品需要的分片数（至少 1 片，最多 LAST_SITEMAP_PAGE 片） */
export function gallerySitemapShards(count: number): number {
  return Math.min(LAST_SITEMAP_PAGE, Math.max(1, Math.ceil(count / SITEMAP_PAGE_SIZE)))
}

const xml = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } })

/**
 * `shard` 为 `'root'` 时是 /sitemap-gallery.xml：只有一片时直接是该片的 urlset，多于一片时改为指向
 * /sitemap-gallery-<n>.xml 的站点地图索引（robots.txt 的一条记录覆盖全部分片）。分片地址只在多于一片时存在。
 */
export async function gallerySitemapResponse(
  request: Request,
  shard: number | 'root',
): Promise<Response> {
  const runtime = getWebRuntime()
  if (pluginUnavailable(runtime, 'studio')) return studioUnavailable()
  const kinds = enabledStudioKinds(templateConfig)
  const site = studioPublicSite(request.url)
  const finish = (response: Response, failed = false) =>
    finishPublicResponse({ request, response, route: 'sitemap', failed, runtime })
  if (!site || kinds.length === 0) return finish(plain(404))
  const scope = { site: site.key, kinds }
  try {
    const shards = gallerySitemapShards(await countPublicSitemapWorks(runtime.publicDb, scope))
    if (shard === 'root' && shards > 1)
      return finish(xml(gallerySitemapIndexXml(site.origin, shards)))
    if (shard !== 'root' && (shards === 1 || shard > shards)) return finish(plain(404))
    const page = shard === 'root' ? 1 : shard
    const { works } = await listPublicSitemapWorks(runtime.publicDb, { ...scope, page })
    return finish(xml(gallerySitemapXml({ origin: site.origin, page, works })))
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return finish(plain(404))
    log.error('studio.sitemap.load_failed', { error })
    return finish(plain(503), true)
  }
}
