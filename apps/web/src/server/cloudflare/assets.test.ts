import { describe, expect, it, vi } from 'vitest'
import { type ProjectGate, responseBeforeRuntime } from './assets.ts'

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } })

/** 只有 /about 与 /sites/b/about 两份预渲染页的 ASSETS。 */
function setup(gate: Partial<ProjectGate> = {}) {
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname
    if (path === '/about') return html('site-a')
    if (path === '/sites/b/about') return html('site-b')
    return new Response('missing', { status: 404 })
  })
  const env = { ASSETS: { fetch } } as unknown as Cloudflare.Env
  const project: ProjectGate = {
    staticFirst: true,
    gateProjectRequest: () => undefined,
    ...gate,
  }
  return {
    fetch,
    run: (url: string, envValid = true) =>
      responseBeforeRuntime(new Request(url), { env, envValid }, project),
  }
}

describe('静态资源前的项目闸门', () => {
  it('默认实现不处理：命中的静态页直接返回，未命中交给运行时', async () => {
    const { run } = setup()
    expect(await (await run('https://a.example/about'))?.text()).toBe('site-a')
    expect(await run('https://a.example/login')).toBeNull()
  })

  it('钩子返回 Response 时短路，不查静态资源', async () => {
    const { run, fetch } = setup({
      gateProjectRequest: (request) =>
        new URL(request.url).pathname.startsWith('/en/')
          ? Response.redirect('https://a.example/about', 301)
          : undefined,
    })
    const response = await run('https://a.example/en/about')
    expect(response?.status).toBe(301)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('钩子改写的请求只用于查找静态资源', async () => {
    const { run, fetch } = setup({
      gateProjectRequest: (request) => {
        const url = new URL(request.url)
        if (url.hostname !== 'b.example') return undefined
        url.pathname = `/sites/b${url.pathname}`
        return new Request(url, request)
      },
    })
    expect(await (await run('https://b.example/about'))?.text()).toBe('site-b')
    expect(await (await run('https://a.example/about'))?.text()).toBe('site-a')
    // 改写后未命中：交给运行时（入口沿用原始请求）
    expect(await run('https://b.example/login')).toBeNull()
    expect(new URL(fetch.mock.calls.at(-1)?.[0].url ?? '').pathname).toBe('/sites/b/login')
  })

  it('环境校验失败时钩子仍先执行，命中的静态页照常返回', async () => {
    const gate = vi.fn(() => undefined)
    const { run } = setup({ gateProjectRequest: gate })
    expect(await (await run('https://a.example/about', false))?.text()).toBe('site-a')
    expect(gate).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ envValid: false }),
    )
  })

  it('staticFirst 为 false：校验失败时不返回静态页，钩子仍先执行；校验通过时照常返回', async () => {
    const gate = vi.fn((request: Request) =>
      new URL(request.url).pathname === '/gone' ? new Response('gone', { status: 404 }) : undefined,
    )
    const { run, fetch } = setup({ staticFirst: false, gateProjectRequest: gate })
    expect(await run('https://a.example/about', false)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect((await run('https://a.example/gone', false))?.status).toBe(404)
    expect(await (await run('https://a.example/about', true))?.text()).toBe('site-a')
  })
})
