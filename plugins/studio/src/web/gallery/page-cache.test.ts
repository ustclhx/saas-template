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

  it('缓存键包含站点地址、部署版本与原路径查询', () => {
    const url = new URL('https://www.example.com/gallery?kind=video')
    expect(pageCacheKey(url, 'https://example.com', 'abc')).toBe(
      'https://example.com/__studio-cache/abc/gallery?kind=video',
    )
    expect(pageCacheKey(url, 'https://example.com', 'def')).not.toBe(
      pageCacheKey(url, 'https://example.com', 'abc'),
    )
    expect(workPageCacheKeys('https://example.com', 'a-b12', 'abc')).toEqual(
      expect.arrayContaining([
        'https://example.com/__studio-cache/abc/gallery/a-b12',
        'https://example.com/__studio-cache/abc/zh/gallery/a-b12',
      ]),
    )
  })

  it('Cache-Control：匿名共享缓存 5 分钟（站点地图 1 小时），会话不缓存，错误 no-store', () => {
    expect(cacheControl('work', { anonymous: true, failed: false })).toBe(
      'public, max-age=0, s-maxage=300',
    )
    expect(cacheControl('sitemap', { anonymous: true, failed: false })).toBe(
      'public, max-age=0, s-maxage=3600',
    )
    expect(cacheControl('gallery', { anonymous: false, failed: false })).toBe('private, no-store')
    expect(cacheControl('gallery', { anonymous: true, failed: true })).toBe('no-store')
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
