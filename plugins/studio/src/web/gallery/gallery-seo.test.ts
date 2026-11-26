import { templateConfig } from '@web/server/template-config.ts'
import { describe, expect, it } from 'vitest'
import { galleryHead, type WorkHeadInput, workHead } from './gallery-seo.ts'
import {
  gallerySitemapIndexXml,
  gallerySitemapShards,
  gallerySitemapXml,
} from './sitemap.server.ts'

const appUrl = 'https://example.com'
const { defaultLocale, enabled, locales } = templateConfig.i18n
const galleryLocales = enabled ? locales : [defaultLocale]
const otherLocale = galleryLocales.find((locale) => locale !== defaultLocale) ?? defaultLocale
const galleryUrl = (locale: string, origin = appUrl) =>
  `${origin}${locale === defaultLocale ? '' : `/${locale}`}/gallery`
const canonical = (head: { links: readonly { rel: string; href: string }[] }) =>
  head.links.find((link) => link.rel === 'canonical')?.href
const meta = (head: { meta: readonly Record<string, unknown>[] }, key: string) =>
  head.meta.find((tag) => tag.property === key || tag.name === key)?.content
const jsonLd = (head: { scripts: readonly { children: string }[] }) =>
  JSON.parse(head.scripts[0]?.children ?? '{}')

describe('画廊 head', () => {
  const head = (
    search: Parameters<typeof galleryHead>[0]['search'],
    locale: string = defaultLocale,
  ) => galleryHead({ search, locale, appUrl, title: 'Gallery', description: 'd' })

  it('无参数第一页 canonical 指向自身并输出 hreflang', () => {
    for (const locale of galleryLocales) {
      const h = head({}, locale)
      expect(canonical(h)).toBe(galleryUrl(locale))
      for (const language of galleryLocales)
        expect(h.links).toContainEqual({
          rel: 'alternate',
          hrefLang: language,
          href: galleryUrl(language),
        })
    }
  })

  it('筛选地址指向无参数第一页，?page=n 指向自身且不输出 hreflang', () => {
    expect(canonical(head({ kind: 'video', page: 2 }))).toBe(galleryUrl(defaultLocale))
    const paged = head({ page: 3 })
    expect(canonical(paged)).toBe(`${galleryUrl(defaultLocale)}?page=3`)
    expect(meta(paged, 'og:url')).toBe(`${galleryUrl(defaultLocale)}?page=3`)
    expect(paged.links.some((link) => link.rel === 'alternate')).toBe(false)
  })
})

describe('作品页 head', () => {
  const input = (overrides: Partial<WorkHeadInput['work']> = {}): WorkHeadInput => ({
    work: {
      id: '0190a3f0-0000-7000-8000-000000000001',
      slug: 'misty-lake-abc12345',
      version: 2,
      title: 'Misty lake',
      kind: 'image',
      width: 1024,
      height: 768,
      durationMs: null,
      displayName: 'FLUX',
      publishedAt: '2026-11-26T00:00:00.000Z',
      moderation: 'approved',
      ...overrides,
    },
    locale: otherLocale,
    appUrl,
    description: 'desc',
  })

  it('审核通过：无 noindex，canonical 为默认语言地址，分享图为作品本身，ImageObject', () => {
    const head = workHead(input())
    expect(meta(head, 'robots')).toBeUndefined()
    expect(canonical(head)).toBe(`${appUrl}/gallery/misty-lake-abc12345`)
    expect(head.links.some((link) => link.rel === 'alternate')).toBe(false)
    expect(meta(head, 'og:image')).toBe(`${appUrl}/media/w/0190a3f0-0000-7000-8000-000000000001/2`)
    const data = jsonLd(head)
    expect(data['@type']).toBe('ImageObject')
    expect(data.contentUrl).toBe(meta(head, 'og:image'))
    expect(data.width).toBe(1024)
  })

  it('待审核 / 未通过时 noindex', () => {
    for (const moderation of ['pending', 'hidden'])
      expect(meta(workHead(input({ moderation })), 'robots')).toBe('noindex')
  })

  it('视频作品：VideoObject 带 ISO 时长，og:video 指向媒体地址', () => {
    const head = workHead(input({ kind: 'video', durationMs: 5_200 }))
    const data = jsonLd(head)
    expect(data['@type']).toBe('VideoObject')
    expect(data.duration).toBe('PT5S')
    expect(meta(head, 'og:type')).toBe('video.other')
    expect(meta(head, 'og:video')).toContain('/media/w/')
  })
})

describe('多站点地址', () => {
  it('作品页的 canonical、og 与结构化数据使用作品所在站点的来源', () => {
    const origin = 'https://east.example.com'
    const head = workHead({
      work: {
        id: '0190a3f0-0000-7000-8000-000000000001',
        slug: 'clip-abc12345',
        version: 1,
        title: 'Clip',
        kind: 'video',
        width: 640,
        height: 360,
        durationMs: 2_000,
        displayName: 'Wan',
        publishedAt: '2026-11-26T00:00:00.000Z',
        moderation: 'approved',
      },
      locale: otherLocale,
      appUrl: origin,
      description: 'd',
    })
    const urls = [
      canonical(head),
      meta(head, 'og:url'),
      meta(head, 'og:video'),
      jsonLd(head).contentUrl,
      jsonLd(head).url,
    ]
    for (const url of urls) expect(new URL(String(url)).origin).toBe(origin)
    expect(
      canonical(
        galleryHead({
          search: {},
          locale: defaultLocale,
          appUrl: origin,
          title: 't',
          description: 'd',
        }),
      ),
    ).toBe(galleryUrl(defaultLocale, origin))
  })
})

describe('画廊站点地图', () => {
  it('作品多于一片时根地址为索引，指向各分片', () => {
    expect(gallerySitemapShards(0)).toBe(1)
    expect(gallerySitemapShards(49_000)).toBe(1)
    expect(gallerySitemapShards(49_001)).toBe(2)
    expect(gallerySitemapShards(10_000_000)).toBe(10)
    const index = gallerySitemapIndexXml(appUrl, 2)
    expect(index).toContain('<sitemapindex')
    expect(index).toContain(`<loc>${appUrl}/sitemap-gallery-1.xml</loc>`)
    expect(index).toContain(`<loc>${appUrl}/sitemap-gallery-2.xml</loc>`)
  })

  it('第一片首条为各语言画廊列表页，作品带 lastmod；后续分片不含列表页', () => {
    const works = [{ slug: 'a-1', lastmod: new Date('2026-11-26T01:02:03Z') }]
    const workLocation = `<loc>${appUrl}/gallery/a-1</loc>`
    const first = gallerySitemapXml({ origin: appUrl, page: 1, works })
    expect(first.match(/<loc>[^<]+<\/loc>/g)).toEqual([
      ...galleryLocales.map((locale) => `<loc>${galleryUrl(locale)}</loc>`),
      workLocation,
    ])
    expect(first).toContain(`${workLocation}<lastmod>2026-11-26T01:02:03.000Z</lastmod>`)
    const second = gallerySitemapXml({ origin: appUrl, page: 2, works })
    expect(second.match(/<loc>[^<]+<\/loc>/g)).toEqual([workLocation])
  })
})
