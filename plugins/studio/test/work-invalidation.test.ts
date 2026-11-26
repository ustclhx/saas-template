import { type DeletionContext, type DeletionTransaction, registerDeletionStep } from '@saas/auth'
import { log } from '@saas/shared/log'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStudioWorkInvalidator } from '../src/web/work-invalidation.ts'
import { registerStudioDeletionSteps } from '../src/web/works-delete-cleanup.ts'

vi.mock('@saas/auth', () => ({ registerDeletionStep: vi.fn(() => () => {}) }))

const work = {
  id: '0196a7e1-e2d0-7000-8000-000000000001',
  slug: 'sample-work',
  site: 'gallery',
  version: 3,
}
const origin = 'https://gallery.example.test'
const workUrl = `${origin}/media/w/0196a7e1-e2d0-7000-8000-000000000001/3`
const purge = { token: 'test-purge-token', zoneId: '0123456789abcdef0123456789abcdef' }
const originForSite = () => origin

afterEach(() => vi.restoreAllMocks())

describe('Studio 作品缓存失效', () => {
  it('按站点的版本化媒体 URL 清除本地缓存和 Cloudflare 缓存', async () => {
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const resolveOrigin = vi.fn().mockReturnValue(`${origin}/`)
    const cache = { delete: vi.fn().mockResolvedValue(true) }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ success: true }))
    const invalidate = createStudioWorkInvalidator({
      originForSite: resolveOrigin,
      cache,
      purge,
      fetch,
    })

    await invalidate(work)

    expect(resolveOrigin).toHaveBeenCalledExactlyOnceWith(work.site)
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(workUrl)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [input = '', init] = fetch.mock.calls[0] ?? []
    const request = new Request(input, init)
    expect(request.url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${purge.zoneId}/purge_cache`,
    )
    expect(request.method).toBe('POST')
    expect(request.headers.get('authorization')).toBe(`Bearer ${purge.token}`)
    expect(request.headers.get('content-type')).toBe('application/json')
    await expect(request.json()).resolves.toEqual({ files: [workUrl] })
    expect(warning).not.toHaveBeenCalled()
  })

  it.each([undefined, { token: purge.token }, { zoneId: purge.zoneId }])(
    '缺少完整的清除凭据时只清除本地缓存（%j）',
    async (credentials) => {
      const cache = { delete: vi.fn().mockResolvedValue(true) }
      const fetch = vi.fn<typeof globalThis.fetch>()
      const invalidate = createStudioWorkInvalidator({
        originForSite,
        cache,
        ...(credentials ? { purge: credentials } : {}),
        fetch,
      })

      await invalidate(work)

      expect(cache.delete).toHaveBeenCalledExactlyOnceWith(workUrl)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('本地缓存删除失败时仍调用 Cloudflare 清除', async () => {
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const cache = { delete: vi.fn().mockRejectedValue(new Error('local cache unavailable')) }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ success: true }))
    const invalidate = createStudioWorkInvalidator({ originForSite, cache, purge, fetch })

    await expect(invalidate(work)).resolves.toBeUndefined()

    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(workUrl)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 503, success: true },
    { status: 200, success: false },
  ])('Cloudflare 清除失败时保留本地清除并记录脱敏日志（%j）', async ({ status, success }) => {
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const cache = { delete: vi.fn().mockResolvedValue(true) }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json(
          { success, errors: [{ message: `request used ${purge.token}` }] },
          { status },
        ),
      )
    const invalidate = createStudioWorkInvalidator({ originForSite, cache, purge, fetch })

    await expect(invalidate(work)).resolves.toBeUndefined()

    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(workUrl)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warning.mock.calls)).not.toContain(purge.token)
  })

  it('吞掉 Cloudflare 请求异常并隐藏异常中的凭据', async () => {
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(`connection failed using ${purge.token}`))
    const invalidate = createStudioWorkInvalidator({ originForSite, purge, fetch })

    await expect(invalidate(work)).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warning.mock.calls)).not.toContain(purge.token)
  })

  it('删号和删空间均在提交后清除旧版本的媒体地址', async () => {
    const cache = { delete: vi.fn().mockResolvedValue(true) }
    registerStudioDeletionSteps(createStudioWorkInvalidator({ originForSite, cache }))
    const steps = vi.mocked(registerDeletionStep).mock.calls
    expect(steps.map(([kind]) => kind)).toEqual(['account', 'workspace'])
    const context: DeletionContext = {
      actorUserId: work.id,
      workspaceIds: [work.id],
      db: {} as DeletionContext['db'],
    }

    for (const [, step] of steps) {
      const sql = vi.fn((strings: TemplateStringsArray | string[]) => {
        const query = strings.join('')
        if (query.includes('select w.id')) return [{ id: work.id }]
        if (query.includes('returning id, slug, site')) return [work]
        return []
      }) as unknown as DeletionTransaction
      cache.delete.mockClear()
      await step.execute?.(context, sql)
      expect(cache.delete).not.toHaveBeenCalled()
      await step.after?.(context)
      expect(cache.delete).toHaveBeenCalledExactlyOnceWith(workUrl)
    }
  })
})
