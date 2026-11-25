import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ request: new Request('https://example.test/s/demo/token') }))
vi.mock('@tanstack/react-start/server', () => ({ getRequest: () => state.request }))
vi.mock('@saas/shared/log', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('./meta.server.ts', () => ({ shareLookupDeps: () => ({}) }))
vi.mock('./lookup.ts', () => ({
  lookupShare: vi.fn(async () => {
    throw new Error('connect ECONNREFUSED')
  }),
  remainingSeconds: () => 0,
}))

import { log } from '@saas/shared/log'
import { lookupShare } from './lookup.ts'
import { handleSharePageRequest, loadSharePage } from './page.server.ts'

describe('分享页数据库不可达（public-site-availability「兜底错误界面」）', () => {
  it('查找失败时继续渲染错误界面且不进边缘缓存，页面数据不再重复查库', async () => {
    const response = new Response('<html>error page</html>', { status: 500 })
    const next = vi.fn(async () => ({ response }))
    const ctx = await handleSharePageRequest({
      request: state.request,
      params: { type: 'demo', token: 'token' },
      next,
    })
    expect(next).toHaveBeenCalledOnce()
    expect((ctx as { response: Response }).response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toBe('noindex')
    expect(log.error).toHaveBeenCalledWith('share_page.lookup_failed', expect.anything())

    await expect(loadSharePage({ type: 'demo', token: 'token' })).rejects.toMatchObject({
      code: 'SHARE_UNAVAILABLE',
      status: 503,
    })
    expect(lookupShare).toHaveBeenCalledOnce()
  })
})
