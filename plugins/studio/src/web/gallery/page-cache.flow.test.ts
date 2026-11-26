// 边缘缓存与降级的串联验证：Worker 前置处理（查缓存 / 登记回填）→ 文档处理（缓存头、回填、503）。
// Cache API 用内存替身，运行时用最小替身；数据库不可达用抛错的连接模拟。
import { withSecurityNonce } from '@web/security-context.server.ts'
import { type WebRuntime, withWebRuntime } from '@web/server/runtime.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { studioPublicPagesFetch } from '../../worker/page-cache.ts'
import { handleStudioDocument } from './document.server.ts'
import { loadGalleryPage } from './gallery.server.ts'

const request = vi.hoisted(() => ({ current: undefined as Request | undefined }))
vi.mock('@tanstack/react-start/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start/server')>()),
  getRequest: () => request.current,
}))

const APP_URL = 'https://example.com'

function memoryCache() {
  const store = new Map<string, Response>()
  return {
    store,
    match: async (key: string) => store.get(key)?.clone(),
    put: async (key: string, response: Response) => {
      store.set(key, new Response(await response.arrayBuffer(), response))
    },
    delete: async (key: string) => store.delete(key),
  } as unknown as Cache & { store: Map<string, Response> }
}

function runtime(overrides: Partial<WebRuntime> = {}): WebRuntime {
  const down = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('connect ECONNREFUSED')
      },
    },
  )
  return {
    config: { APP_URL },
    pluginStatus: {},
    db: down,
    publicDb: down,
    ...overrides,
  } as unknown as WebRuntime
}

/** 一次完整请求：前置处理命中则直接返回，否则交给文档处理渲染 */
async function serve(
  rt: WebRuntime,
  cache: Cache,
  req: Request,
  render: () => Response,
  nonce = 'nonce-1',
) {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
  const response = await withSecurityNonce(nonce, () =>
    withWebRuntime(rt, async () => {
      const hit = await studioPublicPagesFetch(req, cache, ctx)
      if (hit) return hit
      const result = await handleStudioDocument({
        request: req,
        next: async () => ({ response: render() }),
        route: 'gallery',
      })
      return result instanceof Response ? result : (result as { response: Response }).response
    }),
  )
  await Promise.all(pending)
  return response
}

const page = (nonce: string) =>
  new Response(`<html><script nonce="${nonce}">1</script></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

afterEach(() => {
  request.current = undefined
})

describe('画廊页面边缘缓存', () => {
  it('匿名请求：首次渲染并回填，第二次直接命中（不再渲染），nonce 换成本次请求的值', async () => {
    const cache = memoryCache()
    const rt = runtime()
    const render = vi.fn(() => page('nonce-1'))
    const first = await serve(rt, cache, new Request(`${APP_URL}/gallery?kind=video`), render)
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300')
    expect(await first.text()).toContain('nonce="nonce-1"')
    expect([...cache.store.keys()]).toEqual([
      expect.stringMatching(/^https:\/\/example\.com\/__studio-cache\/[^/]+\/gallery\?kind=video$/),
    ])
    const second = await serve(
      rt,
      cache,
      new Request(`${APP_URL}/gallery?kind=video`),
      render,
      'nonce-2',
    )
    expect(render).toHaveBeenCalledTimes(1)
    expect(second.headers.get('x-studio-cache')).toBe('hit')
    expect(await second.text()).toContain('nonce="nonce-2"')
    // 查询不同是不同的键
    await serve(rt, cache, new Request(`${APP_URL}/gallery`), render)
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('带会话 Cookie 的请求不查也不写缓存', async () => {
    const cache = memoryCache()
    const req = () =>
      new Request(`${APP_URL}/gallery`, { headers: { cookie: 'better-auth.session_token=t' } })
    const render = vi.fn(() => page('n'))
    const response = await serve(runtime(), cache, req(), render)
    await serve(runtime(), cache, req(), render)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(render).toHaveBeenCalledTimes(2)
    expect(cache.store.size).toBe(0)
  })

  it('插件绑定缺失时画廊地址返回 503，其他地址不受影响', async () => {
    const rt = runtime({ pluginStatus: { studio: 'unavailable' } })
    const cache = memoryCache()
    const ctx = { waitUntil: () => {} }
    const response = await withWebRuntime(rt, () =>
      studioPublicPagesFetch(new Request(`${APP_URL}/gallery/a-1`), cache, ctx),
    )
    expect(response?.status).toBe(503)
    expect(
      await withWebRuntime(rt, () =>
        studioPublicPagesFetch(new Request(`${APP_URL}/pricing`), cache, ctx),
      ),
    ).toBeUndefined()
  })
})

describe('数据库不可达', () => {
  it('读取失败：标记本次请求，错误界面以 503 返回且不缓存，其他请求不受影响', async () => {
    const cache = memoryCache()
    const rt = runtime()
    const req = new Request(`${APP_URL}/gallery`)
    request.current = req
    // SSR 中 loader 调用的读取：连接失败转为 503 的 AppError，并标记本次请求
    await expect(withWebRuntime(rt, () => loadGalleryPage({}))).rejects.toMatchObject({
      status: 503,
    })
    const response = await serve(
      rt,
      cache,
      req,
      () => new Response('<html>error</html>', { status: 500 }),
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(cache.store.size).toBe(0)
    // 另一个请求没有失败标记，正常缓存
    const ok = await serve(rt, cache, new Request(`${APP_URL}/gallery`), () => page('n'))
    expect(ok.status).toBe(200)
  })
})
