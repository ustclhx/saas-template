import { describe, expect, it } from 'vitest'
import { galleryHead, type WorkHeadInput, workHead } from './gallery-seo.ts'
import { gallerySitemapXml } from './sitemap.server.ts'

const appUrl = 'https://example.com'
const canonical = (head: { links: readonly { rel: string; href: string }[] }) =>
  head.links.find((link) => link.rel === 'canonical')?.href
const meta = (head: { meta: readonly Record<string, unknown>[] }, key: string) =>
  head.meta.find((tag) => tag.property === key || tag.name === key)?.content
const jsonLd = (head: { scripts: readonly { children: string }[] }) =>
  JSON.parse(head.scripts[0]?.children ?? '{}')

describe('画廊 head', () => {
  const head = (search: Parameters<typeof galleryHead>[0]['search'], locale = 'en') =>
    galleryHead({ search, locale, appUrl, title: 'Gallery', description: 'd' })

  it('无参数第一页 canonical 指向自身并输出 hreflang', () => {
    const h = head({})
    expect(canonical(h)).toBe('https://example.com/gallery')
    expect(h.links.some((link) => link.rel === 'alternate')).toBe(true)
    expect(canonical(head({}, 'zh'))).toBe('https://example.com/zh/gallery')
  })

  it('筛选地址指向无参数第一页，?page=n 指向自身且不输出 hreflang', () => {
    expect(canonical(head({ kind: 'video', page: 2 }))).toBe('https://example.com/gallery')
    const paged = head({ page: 3 })
    expect(canonical(paged)).toBe('https://example.com/gallery?page=3')
    expect(meta(paged, 'og:url')).toBe('https://example.com/gallery?page=3')
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
    locale: 'zh',
    appUrl,
    description: 'desc',
  })

  it('审核通过：无 noindex，canonical 为默认语言地址，分享图为作品本身，ImageObject', () => {
    const head = workHead(input())
    expect(meta(head, 'robots')).toBeUndefined()
    expect(canonical(head)).toBe('https://example.com/gallery/misty-lake-abc12345')
    expect(head.links.some((link) => link.rel === 'alternate')).toBe(false)
    expect(meta(head, 'og:image')).toBe(
      'https://example.com/media/w/0190a3f0-0000-7000-8000-000000000001/2',
    )
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

describe('画廊站点地图', () => {
  it('第一片首条为各语言画廊列表页，作品带 lastmod；后续分片不含列表页', () => {
    const works = [{ slug: 'a-1', lastmod: new Date('2026-11-26T01:02:03Z') }]
    const first = gallerySitemapXml({ origin: appUrl, page: 1, works })
    expect(first.indexOf('<loc>https://example.com/gallery</loc>')).toBeLessThan(
      first.indexOf('<loc>https://example.com/gallery/a-1</loc>'),
    )
    expect(first).toContain('<loc>https://example.com/zh/gallery</loc>')
    expect(first).toContain('<lastmod>2026-11-26T01:02:03.000Z</lastmod>')
    const second = gallerySitemapXml({ origin: appUrl, page: 2, works })
    expect(second).not.toContain('<loc>https://example.com/gallery</loc>')
  })
})
