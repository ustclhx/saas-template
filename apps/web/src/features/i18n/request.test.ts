import { describe, expect, it, vi } from 'vitest'
import { baseLocale, getLocale, isLocale } from '../../paraglide/runtime.js'
import type { WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { languageUrl } from './preference.ts'
import { localizeRequest } from './request.server.ts'
import { readRequestSession, withSessionCache } from './session.server.ts'

vi.mock('@saas/auth', async (original) => ({
  ...(await original<typeof import('@saas/auth')>()),
  requireFreshSession: vi.fn(async ({ headers }) => ({
    user: { id: headers.get('x-user'), locale: headers.get('x-locale') },
    session: {},
  })),
}))

const runtime = { db: {}, auth: {} } as Pick<WebRuntime, 'db' | 'auth'>

const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
const origin = 'https://example.com'

describe('请求级语言与只读会话隔离', () => {
  it('并发账号请求各自保留会话与语言，同一请求只读取一次会话', async () => {
    const { requireFreshSession } = await import('@saas/auth')
    vi.mocked(requireFreshSession).mockClear()
    const run = (locale: string) => {
      const request = new Request(`${origin}/account`, {
        headers: { 'x-user': locale, 'x-locale': locale },
      })
      const handle = async () => {
        await pause()
        const [a, b] = await Promise.all([
          readRequestSession({ headers: request.headers } as Parameters<
            typeof readRequestSession
          >[0]),
          readRequestSession({ headers: request.headers } as Parameters<
            typeof readRequestSession
          >[0]),
        ])
        return Response.json({ locale: getLocale(), a: a.user.id, b: b.user.id })
      }
      return localizeRequest(request, runtime, () =>
        templateConfig.i18n.enabled ? handle() : withSessionCache(handle),
      )
    }
    const responses = await Promise.all([run('zh'), run('en')])
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      {
        locale: templateConfig.i18n.enabled && isLocale('zh') ? 'zh' : baseLocale,
        a: 'zh',
        b: 'zh',
      },
      {
        locale: templateConfig.i18n.enabled && isLocale('en') ? 'en' : baseLocale,
        a: 'en',
        b: 'en',
      },
    ])
    expect(requireFreshSession).toHaveBeenCalledTimes(2)
  })

  it('公开 server function 用同源来源页的 URL 语言，Cookie 不覆盖营销页', async () => {
    const request = new Request(`${origin}/_serverFn/test`, {
      headers: { referer: `${origin}/zh/pricing`, cookie: 'PARAGLIDE_LOCALE=en' },
    })
    const response = await localizeRequest(request, runtime, async () => new Response(getLocale()))
    expect(await response.text()).toBe(
      templateConfig.i18n.enabled && isLocale('zh') ? 'zh' : baseLocale,
    )
    expect(
      languageUrl(new Request(request, { headers: { referer: 'https://other.test/zh/pricing' } }))
        .pathname,
    ).toBe('/_serverFn/test')
  })

  it('语言识别不消耗 server function 的 POST 请求体', async () => {
    const request = new Request(`${origin}/_serverFn/test`, {
      method: 'POST',
      body: 'zh',
      headers: { referer: `${origin}/pricing` },
    })
    const response = await localizeRequest(
      request,
      runtime,
      async () => new Response(await request.text()),
    )
    expect(await response.text()).toBe('zh')
  })

  it('独立请求缓存上下文结束后不再复用会话', async () => {
    const { requireFreshSession } = await import('@saas/auth')
    vi.mocked(requireFreshSession).mockClear()
    const options = { headers: new Headers({ 'x-user': 'one' }) } as Parameters<
      typeof readRequestSession
    >[0]
    await withSessionCache(() =>
      Promise.all([readRequestSession(options), readRequestSession(options)]),
    )
    await readRequestSession(options)
    expect(requireFreshSession).toHaveBeenCalledTimes(2)
  })
})

it('账号语言只在多语言模式读取，单语言忽略 Cookie 和账号偏好', async () => {
  const { requireFreshSession } = await import('@saas/auth')
  vi.mocked(requireFreshSession).mockClear()
  const request = new Request(`${origin}/account`, {
    headers: { 'x-user': 'one', 'x-locale': 'zh', cookie: 'PARAGLIDE_LOCALE=en' },
  })
  const response = await localizeRequest(request, runtime, async () => new Response(getLocale()))
  expect(await response.text()).toBe(
    templateConfig.i18n.enabled && isLocale('zh') ? 'zh' : baseLocale,
  )
  expect(requireFreshSession).toHaveBeenCalledTimes(templateConfig.i18n.enabled ? 1 : 0)
  if (!templateConfig.i18n.enabled) {
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
  }
})

describe('公开页语言只由 URL 决定（multilingual-seo 2.2、2.4）', () => {
  const { enabled, defaultLocale } = templateConfig.i18n
  const other = templateConfig.i18n.locales.find((locale) => locale !== defaultLocale)
  // 模拟路由器：返回本次请求的语言；交给路由器的地址不变
  const render = (path: string, headers: Record<string, string>) =>
    localizeRequest(new Request(`${origin}${path}`, { headers }), runtime, async () =>
      Response.json({ locale: getLocale() }),
    )
  const variants: Record<string, string>[] = [
    {},
    { 'accept-language': 'zh-CN,zh;q=0.9' },
    { 'accept-language': 'en-US,en;q=0.9' },
    { 'accept-language': 'ar' },
    { cookie: `PARAGLIDE_LOCALE=${other ?? defaultLocale}` },
    { cookie: `PARAGLIDE_LOCALE=${defaultLocale}; locale-preference=${defaultLocale}` },
    { 'sec-fetch-dest': 'document', 'accept-language': 'zh-CN', cookie: 'PARAGLIDE_LOCALE=zh' },
  ]

  it('带默认语言前缀的地址 301 到无前缀地址，保留查询串，不看请求头', async () => {
    if (!enabled) return
    for (const headers of variants) {
      for (const [from, to] of [
        [`/${defaultLocale}/pricing`, '/pricing'],
        [`/${defaultLocale}`, '/'],
        [`/${defaultLocale.toUpperCase()}/pricing?ref=a`, '/pricing?ref=a'],
      ]) {
        const response = await render(from as string, headers)
        expect(response.status, from).toBe(301)
        expect(response.headers.get('location'), from).toBe(to)
        expect(response.headers.get('set-cookie')).toBeNull()
      }
    }
  })

  it('不同 Accept-Language 与 Cookie 下状态、Location 与语言一致，且没有语言 Set-Cookie', async () => {
    const paths = [
      '/',
      '/pricing',
      '/blog',
      ...(enabled && other ? [`/${other}`, `/${other}/pricing`] : []),
    ]
    for (const path of paths) {
      const results = await Promise.all(
        variants.map(async (headers) => {
          const response = await render(path, headers)
          expect(response.headers.get('set-cookie'), path).toBeNull()
          return {
            status: response.status,
            location: response.headers.get('location'),
            body: await response.json(),
          }
        }),
      )
      const expected = {
        status: 200,
        location: null,
        body: { locale: enabled && path.startsWith(`/${other}`) ? other : baseLocale },
      }
      for (const result of results) expect(result, path).toEqual(expected)
    }
  })

  it('应用区仍按账号语言写 Cookie（不属于公开页）', async () => {
    if (!enabled || !other) return
    const response = await localizeRequest(
      new Request(`${origin}/account`, { headers: { 'x-user': 'one', 'x-locale': other } }),
      runtime,
      async () => new Response(getLocale()),
    )
    expect(await response.text()).toBe(other)
    expect(response.headers.get('set-cookie')).toContain(`PARAGLIDE_LOCALE=${other}`)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
})
