import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkLinks, hostRequest } from './check-links.mjs'
import { exitCode } from './check-links-graph.mjs'

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
    // 默认语言前缀 301 到无前缀地址（多语言请求规则）
    if (host === 'localhost' && /^\/en(?:\/|$)/.test(request.url ?? '')) {
      response.writeHead(301, { location: (request.url ?? '').slice(3) || '/' }).end()
      return
    }
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
    // 多语言请求规则按站点执行：默认语言前缀只在以无前缀地址服务默认语言的站点（localhost）检查，
    // east.localhost 没有 `/en`（404）也不报告
    expect(
      [...result.failures, ...result.warnings].filter(
        (item) => item.rule === 'default-locale-prefix',
      ),
    ).toEqual([])
  })
})

// 多语言请求规则（openspec multilingual-seo design 决策 7）：Accept-Language 对比、语言 Set-Cookie、默认语言前缀 301。
// 一个单站点 en／zh 的服务；`broken` 打开时模拟按浏览器语言跳转、写语言 Cookie 与 307 前缀跳转
describe('check-links 多语言请求规则', () => {
  let languageServer: Server
  let origin = ''
  let broken = false
  const hreflang = (path: string) => {
    const bare = path.replace(/^\/zh/, '') || '/'
    const zh = bare === '/' ? '/zh' : `/zh${bare}`
    return `<link rel="canonical" href="${origin}${path}"/><link rel="alternate" hreflang="en" href="${origin}${bare}"/><link rel="alternate" hreflang="zh" href="${origin}${zh}"/><link rel="alternate" hreflang="x-default" href="${origin}${bare}"/>`
  }
  const localized = (path: string, nonce: string) => {
    const zh = path.startsWith('/zh')
    const links = zh ? ['/zh', '/zh/pricing', '/'] : ['/', '/pricing', '/zh']
    return `<html lang="${zh ? 'zh' : 'en'}"><head><meta charset="utf-8" nonce="${nonce}"/>${hreflang(path)}</head><body><header data-link-zone="nav"><nav>${links.map((href) => `<a href="${href}">${href}</a>`).join('')}</nav></header><h1>${path}</h1><script nonce="${nonce}">window.$R={u:${Date.now()}}</script></body></html>`
  }

  beforeAll(async () => {
    languageServer = createServer((request, response) => {
      const url = request.url ?? '/'
      const prefers = String(request.headers['accept-language'] ?? '').startsWith('zh')
      if (url === '/sitemap.xml') {
        const locs = ['/', '/pricing', '/zh', '/zh/pricing']
        response
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            `<urlset>${locs.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`,
          )
        return
      }
      if (url === '/en' || url.startsWith('/en/')) {
        response.writeHead(broken ? 307 : 301, { location: url.slice(3) || '/' }).end()
        return
      }
      if (broken && url === '/' && prefers) {
        response.writeHead(302, { location: '/zh' }).end()
        return
      }
      if (!['/', '/pricing', '/zh', '/zh/pricing'].includes(url)) {
        response.writeHead(404, { 'content-type': 'text/html' }).end('<html></html>')
        return
      }
      const headers: Record<string, string | string[]> = { 'content-type': 'text/html' }
      if (broken && url === '/pricing') headers['set-cookie'] = ['PARAGLIDE_LOCALE=en; Path=/']
      // 每次请求不同的 nonce 与时间戳：规范化后应相同
      response.writeHead(200, headers).end(localized(url, crypto.randomUUID()))
    })
    await new Promise<void>((done) => languageServer.listen(0, '127.0.0.1', done))
    origin = `http://127.0.0.1:${(languageServer.address() as AddressInfo).port}`
  })

  afterAll(() => {
    languageServer.close()
  })

  const check = () =>
    checkLinks({
      baseUrl: origin,
      mode: 'enforce',
      localize: (locale) => (locale === 'en' ? '/' : `/${locale}`),
      cookieName: 'PARAGLIDE_LOCALE',
      templateConfig: {
        app: { url: origin },
        i18n: { enabled: true, locales: ['en', 'zh'], defaultLocale: 'en' },
        seo: { linking: {} },
      },
    })
  const languageRules = new Set([
    'accept-language-vary',
    'language-set-cookie',
    'default-locale-prefix',
    'hreflang-reciprocal',
    'hreflang-x-default',
    'hreflang-target',
    'html-lang',
    'canonical-self',
  ])
  const findings = (result: Awaited<ReturnType<typeof check>>['result']) =>
    [...result.failures, ...result.warnings]
      .filter((item) => languageRules.has(item.rule))
      .map(({ rule, page }) => ({ rule, page }))

  it('不按请求头改变响应、不写语言 Cookie、默认语言前缀 301 时没有多语言问题', async () => {
    broken = false
    const { result } = await check()
    expect(result.stats.pages).toBe(4)
    expect(findings(result)).toEqual([])
  })

  it('按 Accept-Language 跳转、公开页写语言 Cookie、前缀 307 时报告', async () => {
    broken = true
    const { result, mode } = await check()
    expect(findings(result)).toEqual([
      { rule: 'language-set-cookie', page: '/pricing' },
      { rule: 'accept-language-vary', page: '/' },
      { rule: 'default-locale-prefix', page: '/en' },
      { rule: 'default-locale-prefix', page: '/en/pricing' },
    ])
    // 按浏览器语言跳转与默认语言前缀未 301 均为失败级，enforce 下退出码非零
    expect(exitCode(result, mode)).toBe(1)
    expect(result.failures.map((item) => item.rule)).toContain('default-locale-prefix')
  })
})
