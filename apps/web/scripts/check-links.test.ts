import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkLinks, hostRequest } from './check-links.mjs'

// 多站点链接图检查（docs/seo-internal-linking.md「多站点」）：同一服务按 Host 返回两个站点，
// 检查脚本以 Host 请求头访问各站点，不依赖 `*.localhost` 的 DNS 解析
const page = (lang: string, title: string, links: string[]) =>
  `<html lang="${lang}"><body><header data-link-zone="nav"><nav>${['a', 'b', 'c'].map((label) => `<a href="${links[0]}">${label}</a>`).join('')}</nav></header><h1>${title}</h1>${links.map((href) => `<a href="${href}">${title} ${href}</a>`).join('')}</body></html>`

let server: Server
let port = 0
const sites: Record<string, Record<string, string>> = {}

beforeAll(async () => {
  server = createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? ''
    const body = sites[host]?.[request.url ?? '']
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/html' }).end('<html></html>')
      return
    }
    const xml = body.startsWith('<urlset')
    response.writeHead(200, { 'content-type': xml ? 'application/xml' : 'text/html' }).end(body)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  port = (server.address() as AddressInfo).port
  const west = `http://localhost:${port}`
  const east = `http://east.localhost:${port}`
  const urlset = (origin: string, paths: string[]) =>
    `<urlset>${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`
  sites.localhost = {
    '/sitemap.xml': urlset(west, ['/', '/pricing']),
    // 指向另一站点的链接不并入本图
    '/': page('en', 'Home', ['/pricing', `${east}/zh-hant`]),
    '/pricing': page('en', 'Pricing', ['/']),
  }
  sites['east.localhost'] = {
    '/sitemap.xml': urlset(east, ['/zh-hant', '/zh-hant/about']),
    '/zh-hant': page('zh-Hant', '首頁', ['/zh-hant/about', '/zh-hant/missing']),
    '/zh-hant/about': page('zh-Hant', '關於', ['/zh-hant']),
  }
})

afterAll(() => {
  server.close()
})

describe('check-links 多站点', () => {
  it('hostRequest 连接 preview 地址并以原主机作 Host', async () => {
    const send = hostRequest(`http://127.0.0.1:${port}`, new Set(['east.localhost']))
    const response = await send(`http://east.localhost:${port}/zh-hant`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('首頁')
  })

  it('每个 previewHost 各成一图，语言首页取路由前缀，明细带主机名', async () => {
    const { result } = await checkLinks({
      baseUrl: `http://127.0.0.1:${port}`,
      mode: 'enforce',
      localize: (locale) => (locale === 'en' ? '/' : `/${locale.toLowerCase()}`),
      templateConfig: {
        app: { url: 'https://example.com' },
        i18n: { enabled: true, locales: ['en', 'zh-Hant'], defaultLocale: 'en' },
        seo: {
          linking: {
            sites: [
              { locales: ['en'], previewHost: 'localhost' },
              { locales: ['zh-Hant'], previewHost: 'east.localhost' },
            ],
          },
        },
      },
    })
    expect(result.stats).toEqual({ pages: 4, links: 18, edges: 4, maxDepth: 1 })
    expect(result.sites).toMatchObject({
      localhost: { pages: 2, links: 9, maxDepth: 1, counts: { failures: { 'dead-link': 0 } } },
      'east.localhost': {
        pages: 2,
        links: 9,
        maxDepth: 1,
        counts: { failures: { 'dead-link': 1 } },
      },
    })
    expect(result.failures).toEqual([
      expect.objectContaining({
        rule: 'dead-link',
        page: 'east.localhost/zh-hant',
        target: '/zh-hant/missing',
      }),
    ])
  })
})
