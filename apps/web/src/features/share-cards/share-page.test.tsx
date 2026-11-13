import { shareCardRevokedKey } from '@saas/storage'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type WebRuntime, withWebRuntime } from '../../server/runtime.ts'
import { lookupShare, type ShareLookupDeps } from './lookup.ts'
import { shareCardMeta } from './meta.server.ts'
import { shareCardImagePath } from './meta.ts'
import { loadSharePage } from './page.server.ts'
import { registerShareCard } from './registry.ts'
import { SharePage, SharePageGone } from './share-page.tsx'
import type { ShareCardDefinition, ShareResolution } from './types.ts'

const headers = vi.hoisted(() => ({ values: new Map<string, string>(), status: 200 }))
// 页头页脚的链接只需输出 href，组件测试不搭建完整路由。
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: () => false,
}))
vi.mock('@tanstack/react-start/server', () => ({
  setResponseHeader: (name: string, value: string) => headers.values.set(name, value),
  setResponseStatus: (status: number) => {
    headers.status = status
  },
}))

interface Data {
  title: string
  description: string
}

const token = 'AbCdEfGhIjKlMnOpQrStUv_-0123456789'
const now = new Date('2026-11-13T00:00:00Z')
const shares = new Map<string, ShareResolution<Data>>()
const resolve = vi.fn(async (value: string) => shares.get(value) ?? null)
const definition = (type: string, extra: Partial<ShareCardDefinition<Data>> = {}) =>
  registerShareCard<Data>({
    type,
    version: 3,
    resolve,
    digest: (data) => `digest-${data.title.length}-abcdef`,
    render: () => <div />,
    alt: (data) => `Card: ${data.title}`,
    page: (data) => ({ title: data.title, description: data.description, label: 'Report' }),
    ...extra,
  })

const card = definition('page-test')
definition('page-off-test', { sharePage: false })
definition('page-month-test', { ttlDays: 30 })

function deps(overrides: Partial<ShareLookupDeps> = {}) {
  const revoked = new Set<string>()
  const limit = vi.fn(async () => ({ success: true }))
  return {
    revoked,
    limit,
    deps: {
      db: {} as ShareLookupDeps['db'],
      cache: { get: async (key: string) => (revoked.has(key) ? '1' : null) },
      rateLimiter: { limit },
      clientIp: '203.0.113.9',
      now,
      ...overrides,
    } satisfies ShareLookupDeps,
  }
}

beforeEach(() => {
  shares.clear()
  resolve.mockClear()
  headers.values.clear()
  headers.status = 200
  shares.set(token, {
    workspaceId: 'workspace-1',
    sharedAt: new Date('2026-11-01T08:00:00Z'),
    data: { title: 'Quarterly survey notes', description: 'Retention rose by 12%.' },
  })
})

describe('share lookup', () => {
  it('returns 404 for unregistered types and disabled share pages without resolving', async () => {
    const { deps: d, limit } = deps()
    expect(await lookupShare(d, { type: 'missing-type', token, page: true })).toEqual({
      status: 'not-found',
    })
    expect(await lookupShare(d, { type: 'page-off-test', token, page: true })).toEqual({
      status: 'not-found',
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(limit).not.toHaveBeenCalled()
    // 关闭通用分享页只影响 /s/，项目自建页面的元数据仍可解析。
    expect((await lookupShare(d, { type: 'page-off-test', token, page: false })).status).toBe('ok')
  })

  it('checks the revocation mark and token format before resolve or rate limiting', async () => {
    const { deps: d, revoked, limit } = deps()
    revoked.add(shareCardRevokedKey('page-test', token))
    expect((await lookupShare(d, { type: 'page-test', token, page: true })).status).toBe(
      'not-found',
    )
    for (const bad of ['short', `${token}!`, '..', 'a'.repeat(65)])
      expect((await lookupShare(d, { type: 'page-test', token: bad, page: true })).status).toBe(
        'not-found',
      )
    expect(resolve).not.toHaveBeenCalled()
    expect(limit).not.toHaveBeenCalled()
  })

  it('returns 404 when resolve is empty and expired after the effective expiry', async () => {
    const { deps: d } = deps()
    const unknown = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'
    expect((await lookupShare(d, { type: 'page-test', token: unknown, page: true })).status).toBe(
      'not-found',
    )
    shares.set(unknown, { ...(shares.get(token) as ShareResolution<Data>), expiresAt: now })
    expect((await lookupShare(d, { type: 'page-test', token: unknown, page: true })).status).toBe(
      'expired',
    )
    // 按类型 30 天：11-01 分享，12-01 起到期；默认 90 天的类型仍有效。
    const later = deps({ now: new Date('2026-12-02T00:00:00Z') }).deps
    expect((await lookupShare(later, { type: 'page-month-test', token, page: true })).status).toBe(
      'expired',
    )
    expect((await lookupShare(later, { type: 'page-test', token, page: true })).status).toBe('ok')
  })

  it('consumes the shareCard policy per client IP and stops before resolve when limited', async () => {
    const { deps: d, limit } = deps()
    limit.mockResolvedValueOnce({ success: false })
    expect((await lookupShare(d, { type: 'page-test', token, page: true })).status).toBe(
      'rate-limited',
    )
    expect(limit).toHaveBeenCalledWith('shareCard', 'share:ip:203.0.113.9')
    expect(resolve).not.toHaveBeenCalled()
  })
})

function runtime(d: ShareLookupDeps) {
  return {
    config: { APP_URL: 'https://app.example' },
    db: d.db,
    cache: d.cache,
    rateLimiter: d.rateLimiter,
    requestMeta: { requestId: 'request', clientIp: d.clientIp },
  } as unknown as WebRuntime
}

describe('share page loader and metadata', () => {
  it('renders valid shares with card metadata, noindex and a five-minute edge cache', async () => {
    const view = await withWebRuntime(runtime(deps().deps), () =>
      loadSharePage({ type: 'page-test', token }),
    )
    expect(headers.values.get('cache-control')).toBe('public, s-maxage=300')
    expect(headers.values.get('x-robots-tag')).toBe('noindex')
    if (view.status !== 'ok') throw new Error(`Unexpected ${view.status}`)
    const image = `https://app.example/share-card/page-test/${token}.png?v=3-digest-2`
    expect(view).toMatchObject({
      title: 'Quarterly survey notes',
      label: 'Report',
      sharedOn: '2026-11-01',
      expiresOn: '2027-01-30',
      card: { image, width: 1200, height: 630, alt: 'Card: Quarterly survey notes' },
    })
    expect(view.meta).toEqual(
      expect.arrayContaining([
        { name: 'robots', content: 'noindex' },
        { property: 'og:image', content: image },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:alt', content: 'Card: Quarterly survey notes' },
        { property: 'og:url', content: `https://app.example/s/page-test/${token}` },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:image', content: image },
      ]),
    )
    // 页面数据不下发空间 ID 等解析结果。
    expect(JSON.stringify(view)).not.toContain('workspace-1')
  })

  it('maps the four 404 cases and keeps noindex; rate limits answer 429 without caching', async () => {
    const d = deps()
    d.revoked.add(shareCardRevokedKey('page-test', 'revokedrevokedrevokedrev'))
    shares.set('expiredexpiredexpiredexp', {
      workspaceId: 'workspace-1',
      sharedAt: new Date('2026-01-01T00:00:00Z'),
      data: { title: 'Old', description: 'Old' },
    })
    const cases = [
      ['missing-type', token, 'not-found'],
      ['page-off-test', token, 'not-found'],
      ['page-test', 'bad', 'not-found'],
      ['page-test', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'not-found'],
      ['page-test', 'revokedrevokedrevokedrev', 'not-found'],
      ['page-test', 'expiredexpiredexpiredexp', 'expired'],
    ] as const
    for (const [type, value, status] of cases) {
      headers.values.clear()
      const view = await withWebRuntime(runtime(d.deps), () =>
        loadSharePage({ type, token: value }),
      )
      expect(view).toEqual({ status })
      expect(headers.values.get('x-robots-tag')).toBe('noindex')
    }
    d.limit.mockResolvedValueOnce({ success: false })
    const limited = await withWebRuntime(runtime(d.deps), () =>
      loadSharePage({ type: 'page-test', token }),
    )
    expect(limited).toEqual({ status: 'rate-limited' })
    expect(headers.status).toBe(429)
    expect(headers.values.get('cache-control')).toBe('no-store')
  })

  it('shareCardMeta serves self-built pages and returns null for invalid shares', async () => {
    const d = deps().deps
    const meta = await withWebRuntime(runtime(d), () =>
      shareCardMeta('page-off-test', token, { pageUrl: 'https://app.example/own' }),
    )
    expect(meta?.image).toBe(
      `https://app.example/share-card/page-off-test/${token}.png?v=3-digest-2`,
    )
    expect(meta?.meta).toContainEqual({ property: 'og:url', content: 'https://app.example/own' })
    expect(await withWebRuntime(runtime(d), () => shareCardMeta('page-test', 'bad'))).toBeNull()
    // 展示数据变化时地址随摘要变化。
    const data = { title: 'Renamed survey notes', description: '' }
    expect(shareCardImagePath(card, token, data)).toContain('?v=3-digest-2')
    expect(shareCardImagePath(card, token, data)).not.toBe(
      shareCardImagePath(card, token, { title: 'Short', description: '' }),
    )
  })
})

describe('share page view', () => {
  it('shows the card, title, description and site entry; gone states show no resource data', () => {
    const html = renderToStaticMarkup(
      <SharePage
        view={{
          status: 'ok',
          title: 'Quarterly survey notes',
          description: 'Retention rose by 12%.',
          label: 'Report',
          sharedOn: '2026-11-01',
          expiresOn: null,
          card: { image: 'https://app.example/card.png', width: 1200, height: 630, alt: 'Card' },
          meta: [],
        }}
      />,
    )
    for (const text of ['Quarterly survey notes', 'Retention rose by 12%.', 'Report'])
      expect(html).toContain(text)
    expect(html).toContain('src="https://app.example/card.png"')
    expect(html).toContain('href="/register"')
    for (const reason of ['not-found', 'expired', 'rate-limited'] as const) {
      const gone = renderToStaticMarkup(<SharePageGone reason={reason} />)
      expect(gone).toContain(`data-share-page="${reason}"`)
      expect(gone).not.toContain('Quarterly')
    }
  })
})
