import { describe, expect, it, vi } from 'vitest'
import { baseLocale, getLocale } from '../../paraglide/runtime.js'
import type { WebRuntime } from '../../server/runtime.ts'
import { languageUrl, preferredLocale } from './preference.ts'
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
      return localizeRequest(request, runtime, async () => {
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
      })
    }
    const responses = await Promise.all([run('zh'), run('en')])
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { locale: 'zh', a: 'zh', b: 'zh' },
      { locale: 'en', a: 'en', b: 'en' },
    ])
    expect(requireFreshSession).toHaveBeenCalledTimes(2)
  })

  it('公开 server function 用同源来源页的 URL 语言，Cookie 不覆盖营销页', async () => {
    const request = new Request(`${origin}/_serverFn/test`, {
      headers: { referer: `${origin}/zh/pricing`, cookie: 'PARAGLIDE_LOCALE=en' },
    })
    const response = await localizeRequest(request, runtime, async () => new Response(getLocale()))
    expect(await response.text()).toBe('zh')
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

describe('首次访问建议', () => {
  it('按 Accept-Language 的 q 权重、地区语言和禁用项匹配，默认语言也尊重优先级', () => {
    expect(preferredLocale('fr,zh-CN;q=0.8,en;q=0.2')).toBe('zh')
    expect(preferredLocale('zh;q=0,en;q=0.9')).toBe('en')
    expect(preferredLocale('en-US;q=0.9,zh;q=0.8')).toBe('en')
    expect(preferredLocale('zh;q=oops,fr')).toBe(baseLocale)
  })
})
