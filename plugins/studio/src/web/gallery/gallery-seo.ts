// 画廊与作品页的 <head>（design 决策 4、public-gallery「收录规则」）。纯函数，文案由调用方按页面语言传入。
import { absoluteUrl, localizedPath, ogImagePath, pageHead } from '@web/features/seo/metadata.ts'
import { templateConfig } from '@web/server/template-config.ts'
import type { StudioKind } from '../../kinds.ts'
import { studioMediaPath } from '../media-url.ts'
import { type GallerySearch, galleryCanonicalPath, workPath } from './paths.ts'

type Head = ReturnType<typeof pageHead>
type MetaTag = Head['meta'][number]

const NOINDEX = { name: 'robots', content: 'noindex' }

function replaceMeta(meta: readonly MetaTag[], property: string, content: string): MetaTag[] {
  return meta.map((tag) =>
    'property' in tag && tag.property === property ? { ...tag, content } : tag,
  )
}

/**
 * 画廊列表：无参数的第一页与 `?page=n` 的 canonical 指向自身；带类型、排序或游标的地址指向无参数的第一页。
 * hreflang 只在 canonical 为无参数第一页时输出（各语言的画廊首页互为译本）。
 */
export function galleryHead(input: {
  search: GallerySearch
  locale: string
  appUrl: string
  title: string
  description: string
}): Head {
  const { search, locale, appUrl } = input
  const canonicalPath = galleryCanonicalPath(search)
  const head = pageHead(
    {
      path: '/gallery',
      title: input.title,
      description: input.description,
      locale,
      // 画廊不进入构建期页面清单，没有专属分享图，沿用站点首页的分享图
      cover: ogImagePath({ path: '/', locale }),
    },
    appUrl,
  )
  const canonical = absoluteUrl(appUrl, localizedPath(canonicalPath, locale))
  const selfCanonical = canonicalPath === '/gallery'
  return {
    ...head,
    meta: replaceMeta(head.meta, 'og:url', canonical),
    links: selfCanonical ? head.links : [{ rel: 'canonical', href: canonical }],
  }
}

export interface WorkHeadInput {
  work: {
    slug: string
    id: string
    version: number
    title: string
    kind: StudioKind
    width: number | null
    height: number | null
    durationMs: number | null
    displayName: string
    publishedAt: string
    moderation: string
  }
  locale: string
  appUrl: string
  description: string
}

/** ISO 8601 时长（视频结构化数据） */
function isoDuration(durationMs: number): string {
  return `PT${Math.max(1, Math.round(durationMs / 1000))}S`
}

export function workStructuredData({ work, appUrl, description }: WorkHeadInput) {
  const url = absoluteUrl(appUrl, workPath(work.slug))
  const contentUrl = absoluteUrl(appUrl, studioMediaPath(work.id, work.version))
  const base = {
    '@context': 'https://schema.org',
    name: work.title,
    description,
    contentUrl,
    url,
    uploadDate: work.publishedAt,
    ...(work.width && work.height && { width: work.width, height: work.height }),
    creator: { '@type': 'Organization', name: templateConfig.app.name },
  }
  if (work.kind === 'video')
    return {
      '@type': 'VideoObject',
      ...base,
      ...(work.durationMs !== null && { duration: isoDuration(work.durationMs) }),
    }
  return { '@type': 'ImageObject', ...base, datePublished: work.publishedAt }
}

/**
 * 作品页：canonical 指向默认语言的无前缀地址（作品是用户原文，各语言前缀只换界面文案，不做 hreflang 互链）；
 * 图片作品的分享图为作品本身，视频作品附 og:video；未通过审核时 noindex（public-gallery「收录规则」）。
 */
export function workHead(input: WorkHeadInput): Head {
  const { work, appUrl, locale } = input
  const head = pageHead(
    {
      path: workPath(work.slug),
      title: work.title,
      description: input.description,
      locale,
      ...(work.kind === 'image'
        ? { cover: studioMediaPath(work.id, work.version) }
        : { cover: ogImagePath({ path: '/', locale }) }),
    },
    appUrl,
    [workStructuredData(input)],
  )
  const canonical = absoluteUrl(appUrl, workPath(work.slug))
  let meta = replaceMeta(head.meta, 'og:url', canonical)
  if (work.kind === 'image' && work.width && work.height)
    meta.push(
      { property: 'og:image:width', content: String(work.width) },
      { property: 'og:image:height', content: String(work.height) },
    )
  if (work.kind === 'video') {
    meta = replaceMeta(meta, 'og:type', 'video.other')
    meta.push({
      property: 'og:video',
      content: absoluteUrl(appUrl, studioMediaPath(work.id, work.version)),
    })
  }
  if (work.moderation !== 'approved') meta.push(NOINDEX)
  return { ...head, meta, links: [{ rel: 'canonical', href: canonical }] }
}

/** 未找到与错误界面：不收录 */
export function noindexHead(title: string): Pick<Head, 'meta'> {
  return { meta: [{ title: `${title} | ${templateConfig.app.name}` }, NOINDEX] }
}
