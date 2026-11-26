import { withSecurityNonce } from '@web/security-context.server.ts'
import { describe, expect, it } from 'vitest'
import {
  CACHED_NONCE_HEADER,
  cacheControl,
  finishPublicResponse,
  hasSessionCookie,
  pageCacheKey,
  registerPageCachePut,
  restoreCachedPage,
  studioPublicRoute,
  workPageCacheKeys,
} from './page-cache.ts'

const locales = new Set(['en', 'zh'])

describe('公开页缓存规则', () => {
  it('识别画廊、作品页与站点地图（含语言前缀），做同款不缓存', () => {
    expect(studioPublicRoute('/gallery', locales)).toBe('gallery')
    expect(studioPublicRoute('/zh/gallery', locales)).toBe('gallery')
    expect(studioPublicRoute('/gallery/a-b12', locales)).toBe('work')
    expect(studioPublicRoute('/zh/gallery/a-b12', locales)).toBe('work')
    expect(studioPublicRoute('/sitemap-gallery.xml', locales)).toBe('sitemap')
    expect(studioPublicRoute('/sitemap-gallery-3.xml', locales)).toBe('sitemap')
    expect(studioPublicRoute('/gallery/remix/a-b12', locales)).toBeUndefined()
    expect(studioPublicRoute('/fr/gallery', locales)).toBeUndefined()
    expect(studioPublicRoute('/pricing', locales)).toBeUndefined()
  })

  it('会话 Cookie 判定（含 __Secure- 前缀与会话缓存），语言 Cookie 不算', () => {
    expect(hasSessionCookie(null)).toBe(false)
    expect(hasSessionCookie('PARAGLIDE_LOCALE=zh')).toBe(false)
    expect(hasSessionCookie('a=1; better-auth.session_token=x')).toBe(true)
    expect(hasSessionCookie('__Secure-better-auth.session_data=y')).toBe(true)
  })

  it('缓存键：站点来源 + 部署版本 + 规范化路径；画廊只保留规范化筛选，作品页忽略查询', () => {
    const key = (url: string, version = 'abc') =>
      pageCacheKey(new URL(url), 'https://example.com', version)
    expect(key('https://example.com/gallery?kind=video')).toBe(
      'https://example.com/__studio-cache/abc/gallery?kind=video',
    )
    // 参数顺序、未知参数（utm）与第一页的 page=1 不影响键
    expect(key('https://example.com/gallery?utm_source=x&page=2&kind=video')).toBe(
      'https://example.com/__studio-cache/abc/gallery?kind=video&page=2',
    )
    expect(key('https://example.com/gallery/?page=1&utm_medium=y')).toBe(
      'https://example.com/__studio-cache/abc/gallery',
    )
    expect(key('https://example.com/zh/gallery?sort=featured&kind=image')).toBe(
      'https://example.com/__studio-cache/abc/zh/gallery?kind=image&sort=featured',
    )
    expect(key('https://example.com/gallery/a-b12?utm_source=x&ref=y')).toBe(
      'https://example.com/__studio-cache/abc/gallery/a-b12',
    )
    expect(key('https://example.com/sitemap-gallery.xml?x=1')).toBe(
      'https://example.com/__studio-cache/abc/sitemap-gallery.xml',
    )
    expect(key('https://example.com/gallery', 'def')).not.toBe(key('https://example.com/gallery'))
    expect(key('https://example.com/pricing')).toBeUndefined()
    // 失效覆盖带跟踪参数的作品页（同一个键）
    expect(workPageCacheKeys('https://example.com', 'a-b12', 'abc')).toEqual(
      expect.arrayContaining([
        key('https://example.com/gallery/a-b12?utm_source=x'),
        key('https://example.com/zh/gallery/a-b12'),
      ]),
    )
  })

  it('Cache-Control：只有匿名 200 / 404 共享缓存（站点地图 1 小时），会话不缓存，其余状态 no-store', () => {
    const anonymous = { anonymous: true, failed: false }
    expect(cacheControl('work', { ...anonymous, status: 200 })).toBe(
      'public, max-age=0, s-maxage=300',
    )
    expect(cacheControl('work', { ...anonymous, status: 404 })).toBe(
      'public, max-age=0, s-maxage=300',
    )
    expect(cacheControl('sitemap', { ...anonymous, status: 200 })).toBe(
      'public, max-age=0, s-maxage=3600',
    )
    for (const status of [301, 302, 429, 500, 503])
      expect(cacheControl('gallery', { ...anonymous, status })).toBe('no-store')
    expect(cacheControl('gallery', { anonymous: false, failed: false, status: 200 })).toBe(
      'private, no-store',
    )
    expect(cacheControl('gallery', { anonymous: true, failed: true, status: 200 })).toBe('no-store')
  })
})

describe('渲染后的响应处理', () => {
  const html = () =>
    new Response('<script nonce="n-1">x</script>', { headers: { 'content-type': 'text/html' } })

  it('匿名 200 回填边缘缓存：分出一份并记录 nonce，客户端响应正文不变', async () => {
    const runtime = {}
    const puts: Response[] = []
    registerPageCachePut(runtime, (response) => puts.push(response))
    const response = withSecurityNonce('n-1', () =>
      finishPublicResponse({
        request: new Request('https://example.com/gallery'),
        response: html(),
        route: 'gallery',
        failed: false,
        runtime,
      }),
    )
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300')
    expect(puts).toHaveLength(1)
    expect(puts[0]?.headers.get(CACHED_NONCE_HEADER)).toBe('n-1')
    expect(await response.text()).toBe('<script nonce="n-1">x</script>')
    // 命中时换成新请求的 nonce
    const restored = await restoreCachedPage(puts[0] as Response, 'n-2')
    expect(await restored.text()).toBe('<script nonce="n-2">x</script>')
    expect(restored.headers.get(CACHED_NONCE_HEADER)).toBeNull()
    expect(restored.headers.get('x-studio-cache')).toBe('hit')
  })

  it('读取失败改为 503 且不缓存', () => {
    const runtime = {}
    const puts: Response[] = []
    registerPageCachePut(runtime, (response) => puts.push(response))
    const response = finishPublicResponse({
      request: new Request('https://example.com/gallery'),
      response: new Response('error', { status: 500 }),
      route: 'gallery',
      failed: true,
      runtime,
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(puts).toHaveLength(0)
  })

  it('有会话或带 Set-Cookie 的响应不进入共享缓存', () => {
    for (const [request, upstream] of [
      [
        new Request('https://example.com/gallery', {
          headers: { cookie: 'better-auth.session_token=x' },
        }),
        html(),
      ],
      [
        new Request('https://example.com/gallery'),
        new Response('x', { headers: { 'set-cookie': 'a=1' } }),
      ],
    ] as const) {
      const runtime = {}
      const puts: Response[] = []
      registerPageCachePut(runtime, (response) => puts.push(response))
      finishPublicResponse({
        request,
        response: upstream,
        route: 'gallery',
        failed: false,
        runtime,
      })
      expect(puts).toHaveLength(0)
    }
  })
})
