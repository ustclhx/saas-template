import type { APIRequestContext } from '@playwright/test'
import { evidence, expect, login, requireEnv, test } from './support.ts'

// add-og-images 8.2：示例卡片的冷 / 热渲染、缓存命中、摘要变化 302、失效后 404。
// 只用固定示例数据（/api/dev/share-cards，UI_PREVIEW + 平台管理员）。
type Fetch = { status: number; ms: number; bytes: number; headers: Record<string, string> }

async function timed(request: APIRequestContext, url: string): Promise<Fetch> {
  const started = performance.now()
  const response = await request.get(url, { maxRedirects: 0 })
  const body = await response.body()
  const pick = [
    'cache-control',
    'content-type',
    'x-robots-tag',
    'x-content-type-options',
    'location',
    'cf-cache-status',
    'age',
  ]
  const headers = Object.fromEntries(
    Object.entries(response.headers()).filter(([key]) => pick.includes(key)),
  )
  return {
    status: response.status(),
    ms: Math.round(performance.now() - started),
    bytes: body.length,
    headers,
  }
}

function pngSize(buffer: Buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

test('share cards on staging @share-cards', async ({ page }) => {
  requireEnv(['STAGING_URL'])
  const base = process.env.STAGING_URL?.replace(/\/$/, '') ?? ''
  await login(page, 'admin')
  const request = page.context().request
  const results: Record<string, unknown> = {}
  for (const variant of ['zh', 'en'] as const) {
    const created = await request.post(`${base}/api/dev/share-cards`, {
      headers: { origin: base },
      data: { action: 'create', variant },
    })
    expect(created.status()).toBe(200)
    const { token, page: pagePath } = (await created.json()) as { token: string; page: string }
    const html = await request.get(`${base}${pagePath}`)
    expect(html.status()).toBe(200)
    expect(html.headers()['x-robots-tag']).toContain('noindex')
    const image = /<meta property="og:image" content="([^"]+)"/.exec(await html.text())?.[1]
    expect(image).toBeTruthy()
    const cardUrl = image?.replaceAll('&amp;', '&') ?? ''
    const first = await timed(request, cardUrl)
    const second = await timed(request, cardUrl)
    const png = await (await request.get(cardUrl)).body()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 })
    const stale = await timed(request, cardUrl.replace(/v=[^&]+/, 'v=1-00000000'))
    expect(stale.status).toBe(302)
    const invalidated = await request.post(`${base}/api/dev/share-cards`, {
      headers: { origin: base },
      data: { action: 'invalidate', token },
    })
    expect(invalidated.status()).toBe(200)
    const cardAfter = await timed(request, cardUrl)
    const pageAfter = await request.get(`${base}${pagePath}`)
    expect(cardAfter.status).toBe(404)
    expect(pageAfter.status()).toBe(404)
    await test.info().attach(`card-${variant}.png`, { body: png, contentType: 'image/png' })
    results[variant] = {
      first,
      second,
      size: pngSize(png),
      stale,
      cardAfter: { status: cardAfter.status, headers: cardAfter.headers },
      pageAfter: pageAfter.status(),
    }
  }
  await evidence('share-cards-8.2', results)
})
