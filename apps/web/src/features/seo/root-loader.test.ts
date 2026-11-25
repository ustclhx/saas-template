import { describe, expect, it, vi } from 'vitest'

// server function 直接执行 handler；真实的会话与设置读取链路保留，只让 runtime 的 db / auth 抛错
vi.mock('@tanstack/react-start', async (original) => {
  const actual = await original<typeof import('@tanstack/react-start')>()
  const createServerFn = () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      validator: () => builder,
      handler: (handle: (options: unknown) => unknown) => (options?: unknown) =>
        handle(options ?? {}),
    }
    return builder
  }
  return { ...actual, createServerFn }
})
vi.mock('@tanstack/react-start/server', async (original) => ({
  ...(await original<typeof import('@tanstack/react-start/server')>()),
  getRequest: () => new Request('https://example.test/blog', { headers: { cookie: 'session=x' } }),
}))
vi.mock('@saas/shared/log', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const failing = () => {
  throw new Error('connect ECONNREFUSED')
}
vi.mock('../../server/runtime.ts', async (original) => ({
  ...(await original<typeof import('../../server/runtime.ts')>()),
  getWebRuntime: () => ({
    config: { APP_URL: 'https://example.test' },
    get db() {
      return failing()
    },
    get auth() {
      return failing()
    },
    cache: { get: failing, put: failing, delete: failing },
  }),
}))

import { Route } from '../../routes/__root.tsx'

describe('根 loader 在数据库与认证故障时降级（public-site-availability）', () => {
  it('runtime 的 db / auth 抛错时仍 resolve：无模拟登录、无公告', async () => {
    const loader = Route.options.loader as unknown as () => Promise<Record<string, unknown>>
    await expect(loader()).resolves.toMatchObject({
      impersonation: null,
      announcement: '',
      appUrl: 'https://example.test',
    })
  })
})
