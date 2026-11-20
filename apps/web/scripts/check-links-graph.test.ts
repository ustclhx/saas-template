import { describe, expect, it } from 'vitest'
import {
  analyzeLinkGraph,
  type CheckedPage,
  classifyHref,
  countByRule,
  exitCode,
  type FetchedTarget,
  formatReport,
  type LinkingConfig,
  mergeGraphResults,
  parsePage,
  planLinkGraphs,
  resolveLinkingConfig,
  sitemapLocations,
} from './check-links-graph.mjs'

const ORIGIN = 'http://localhost:4000'
// 站点地址写完整 URL：生成新项目时 create-project 只替换 `https://<模板域名>`，主机集合由它推出才能保持一致
const SITE = 'https://example.com'
const HOSTS = new Set(['localhost:4000', new URL(SITE).host])

// 与模板渲染同形的夹具：页头（导航层，含 3 个频道与登录）、正文、页脚（导航层）
const header = (extra = '') =>
  `<header data-link-zone="nav"><a href="/">MyApp</a><nav aria-label="Main"><a href="/pricing">Pricing</a><a href="/blog">Blog</a><a href="/guides">Guides</a></nav><a href="/login">Sign in</a>${extra}</header>`
const footer = (extra = '') =>
  `<footer data-link-zone="nav"><a href="/pricing">Pricing</a><a href="/register">Get started</a>${extra}</footer>`
const html = (body: string, options: { lang?: string; head?: string; h1?: string | null } = {}) =>
  `<!DOCTYPE html><html lang="${options.lang ?? 'en'}"><head><title>T</title>${options.head ?? ''}</head><body>${header()}<main>${options.h1 === null ? '' : `<h1>${options.h1 ?? 'Title'}</h1>`}${body}</main>${footer()}</body></html>`

type Site = Record<string, string>

/** 以夹具 HTML 构造检查输入；`extraTargets` 为站点地图之外的站内地址抓取结果 */
function run(
  site: Site,
  options: {
    config?: Partial<Omit<LinkingConfig, 'thresholds'>> & {
      thresholds?: Partial<LinkingConfig['thresholds']>
    }
    extraTargets?: Record<string, Partial<FetchedTarget>>
    homes?: string[]
    sitemap?: string[]
  } = {},
) {
  const pages: CheckedPage[] = Object.entries(site).map(([path, source]) => ({
    path,
    url: `${ORIGIN}${path}`,
    status: 200,
    parsed: parsePage(source),
  }))
  const targets = new Map<string, FetchedTarget>(pages.map((page) => [page.path, page]))
  const defaults: Record<string, Partial<FetchedTarget>> = {
    '/login': { status: 200 },
    '/register': { status: 200 },
  }
  for (const [path, target] of Object.entries({ ...defaults, ...options.extraTargets }))
    targets.set(path, { url: `${ORIGIN}${path}`, status: 200, ...target })
  return analyzeLinkGraph({
    pages,
    targets,
    indexable: new Set(options.sitemap ?? Object.keys(site)),
    homes: options.homes ?? ['/'],
    internalHosts: HOSTS,
    locales: ['en', 'zh'],
    config: resolveLinkingConfig(options.config),
  })
}

const rules = (items: { rule: string }[]) => items.map((item) => item.rule)

// 一个没有问题的基础站点：首页链接到所有频道，频道页互相可达
const base: Site = {
  '/': html('<a href="/blog/a">Post A</a>', { h1: 'Home' }),
  '/pricing': html('', { h1: 'Pricing' }),
  '/blog': html('<a href="/blog/a">Post A</a>', { h1: 'Blog' }),
  '/blog/a': html('<p>See <a href="/guides">guides</a></p>', { h1: 'Post A' }),
  '/guides': html('', { h1: 'Guides' }),
}

describe('parsePage', () => {
  it('解析链接区域、锚文本、rel、图片 alt、h1 与 head 信息', () => {
    const page = parsePage(
      `<html lang="zh"><head><link rel="canonical" href="https://example.com/x"/><meta name="robots" content="noindex"/></head><body>${header()}<h1>你好 <span>世界</span></h1><div data-link-zone="related" data-link-group="tarot"><a href="/r" rel="nofollow noopener">相关&amp;页</a></div><a href="/img"><img src="a.png" alt=""/></a><a href="/svg" aria-label="Ask AI"><svg><path d="M0"/></svg></a><script>document.write('<a href="/x">x</a>')</script></body></html>`,
    )
    expect(page.lang).toBe('zh')
    expect(page.canonical).toBe('https://example.com/x')
    expect(page.robots).toBe('noindex')
    expect(page.h1).toEqual(['你好 世界'])
    expect(page.groups).toEqual(['tarot'])
    expect(page.hasNavZone).toBe(true)
    const byHref = Object.fromEntries(page.links.map((link) => [link.href, link]))
    expect(byHref['/pricing']).toMatchObject({ zone: 'nav', region: 'header', inNav: true })
    expect(byHref['/login']).toMatchObject({ zone: 'nav', region: 'header', inNav: false })
    expect(byHref['/r']).toMatchObject({
      zone: 'related',
      text: '相关&页',
      rel: ['nofollow', 'noopener'],
    })
    expect(byHref['/img']).toMatchObject({ zone: 'body', imageOnly: true, imageAltMissing: true })
    expect(byHref['/svg']).toMatchObject({ anchor: 'Ask AI', imageAltMissing: false })
    // 脚本中的字符串不是真实链接
    expect(byHref['/x']).toBeUndefined()
  })

  it('按钮与 onclick 跳转不计入链接', () => {
    const page = parsePage(
      '<button onclick="location.href=\'/a\'">Go</button><a onclick="go()">No href</a>',
    )
    expect(page.links).toEqual([])
  })
})

describe('classifyHref', () => {
  it('区分站内、站外与不可抓取的链接', () => {
    const page = `${ORIGIN}/blog/a`
    expect(classifyHref('/blog/', page, HOSTS)).toEqual({ kind: 'internal', path: '/blog' })
    expect(classifyHref('https://example.com/x?y=1#z', page, HOSTS)).toEqual({
      kind: 'internal',
      path: '/x?y=1',
    })
    expect(classifyHref('https://west.example.org/a', page, HOSTS)).toMatchObject({
      kind: 'external',
      host: 'west.example.org',
    })
    expect(classifyHref('#top', page, HOSTS)).toBeNull()
    expect(classifyHref('mailto:a@b.c', page, HOSTS)).toBeNull()
  })
})

describe('resolveLinkingConfig', () => {
  it('未配置时为 report 与默认阈值，配置逐项覆盖', () => {
    expect(resolveLinkingConfig(undefined)).toMatchObject({
      mode: 'report',
      hubPageSize: 100,
      thresholds: { maxDepth: 3, footerLinksMax: 10, headerLinksMin: 3, headerLinksMax: 7 },
    })
    const config = resolveLinkingConfig({
      mode: 'enforce',
      sisterDomains: ['west.example.org'],
      thresholds: { maxDepth: 5 },
    })
    expect(config.mode).toBe('enforce')
    expect(config.sisterDomains).toEqual(['west.example.org'])
    expect(config.thresholds).toMatchObject({ maxDepth: 5, footerLinksMax: 10 })
    // 与 template config 同一套解析：非法值报错，不静默回退
    expect(() => resolveLinkingConfig({ mode: 'strict' })).toThrow(/seo\.linking\.mode/)
  })
})

describe('analyzeLinkGraph', () => {
  it('基础站点没有失败与警告', () => {
    const result = run(base)
    expect(result.failures).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('孤岛：只在站点地图中、没有站内入链', () => {
    const result = run({ ...base, '/guides/lonely': html('', { h1: 'Lonely' }) })
    expect(result.failures).toEqual([
      expect.objectContaining({ rule: 'orphan', page: '/guides/lonely' }),
    ])
  })

  it('只有自链接的页面仍是孤岛', () => {
    const result = run({ ...base, '/self': html('<a href="/self">Self</a>', { h1: 'Self' }) })
    expect(rules(result.failures)).toEqual(['orphan'])
  })

  it('死链：站内链接目标返回 404，同页重复链接只报一次', () => {
    const result = run(
      {
        ...base,
        '/blog/a': html(
          '<a href="/gone">Gone</a><a href="/gone">Gone again</a><a href="/guides">G</a>',
          { h1: 'Post A' },
        ),
      },
      { extraTargets: { '/gone': { status: 404 } } },
    )
    expect(result.failures).toEqual([
      expect.objectContaining({ rule: 'dead-link', page: '/blog/a', target: '/gone' }),
    ])
  })

  it('正文与区块指向不可索引页失败，导航层与回退页除外', () => {
    const result = run(
      {
        ...base,
        '/blog/a': html(
          [
            '<a href="/register">Start now</a>',
            '<a href="/app">Open app</a>',
            '<a href="/s/card/token">Share</a>',
            '<a href="/blog?tag=x">Tagged</a>',
            '<div data-link-zone="related"><a href="/account">Account</a></div>',
            '<a href="/zh/blog/a">中文</a>',
            '<a href="/guides">Guides</a>',
          ].join(''),
          { h1: 'Post A' },
        ),
      },
      {
        extraTargets: {
          '/app': { status: 200 },
          '/account': { status: 200 },
          '/s/card/token': { status: 200, robots: 'noindex' },
          '/blog?tag=x': { status: 200, canonical: '/blog', robots: 'noindex' },
          // 回退页：canonical 指向原语言的可索引地址
          '/zh/blog/a': { status: 200, canonical: 'https://example.com/blog/a' },
        },
      },
    )
    expect(
      result.failures.filter((item) => item.rule === 'link-to-noindex').map((item) => item.target),
    ).toEqual(['/register', '/app', '/s/card/token', '/blog?tag=x', '/account'])
    // 页头 /login 与页脚 /register 在导航层，不计
    expect(result.failures.every((item) => item.page === '/blog/a')).toBe(true)
  })

  it('转化入口（链接自身或祖先 data-link-zone="action"）指向应用区不失败，也不计入正文链接', () => {
    const result = run(
      {
        ...base,
        '/blog/a': html(
          [
            '<a href="/register" data-link-zone="action">Start free</a>',
            '<div data-link-zone="action"><a href="/app">Ask AI</a></div>',
            '<a href="/guides">Guides</a>',
          ].join(''),
          { h1: 'Post A' },
        ),
      },
      { extraTargets: { '/app': { status: 200 } } },
    )
    expect(result.failures).toEqual([])
    const links = parsePage(
      '<div data-link-zone="nav"><a href="/register" data-link-zone="action">Go</a></div>',
    ).links
    expect(links[0]).toMatchObject({ zone: 'action', region: 'a' })
  })

  it('禁用锚文本：默认词与项目增补，忽略大小写与箭头', () => {
    const result = run(
      {
        ...base,
        '/blog/a': html(
          '<a href="/guides">点击这里</a><a href="/pricing">Read More →</a><a href="/blog">Go now</a><a href="/">Click here</a>',
          { h1: 'Post A' },
        ),
      },
      { config: { bannedAnchors: ['go now'] } },
    )
    expect(
      result.failures.filter((item) => item.rule === 'banned-anchor').map((item) => item.target),
    ).toEqual(['/guides', '/pricing', '/blog', '/'])
  })

  it('只含图片的链接缺 alt 失败，有 alt 时通过', () => {
    const result = run({
      ...base,
      '/blog/a': html(
        '<a href="/guides"><img src="x.png"/></a><a href="/pricing"><img src="y.png" alt="Pricing"/></a>',
        {
          h1: 'Post A',
        },
      ),
    })
    expect(result.failures).toEqual([
      expect.objectContaining({ rule: 'image-link-alt', page: '/blog/a' }),
    ])
  })

  it('姊妹站链接：正文带 nofollow 通过；缺 nofollow、在导航层、镜像路径失败', () => {
    const sister = { config: { sisterDomains: ['west.example.org'] } }
    const ok = run(
      {
        ...base,
        '/blog/a': html(
          '<a href="/guides">G</a><a href="https://west.example.org/blog/b" rel="nofollow">West B</a>',
          { h1: 'Post A' },
        ),
      },
      sister,
    )
    expect(ok.failures).toEqual([])

    const bad = run(
      {
        ...base,
        '/blog': html('<a href="/blog/a">Post A</a>', { h1: 'Blog' }).replace(
          '</footer>',
          '<a href="https://west.example.org/" rel="nofollow">West</a></footer>',
        ),
        '/blog/a': html(
          '<a href="/guides">G</a><a href="https://www.west.example.org/x">West X</a><a href="https://west.example.org/blog/a" rel="nofollow">Mirror</a>',
          { h1: 'Post A' },
        ),
      },
      sister,
    )
    expect(rules(bad.failures).sort()).toEqual([
      'sister-in-nav',
      'sister-mirror',
      'sister-nofollow',
    ])
  })

  it('h1 不是恰好一个失败；同语言 h1 重复只警告', () => {
    const result = run({
      ...base,
      '/guides': html('<h1>Second</h1>', { h1: 'Guides' }),
      '/pricing': html('', { h1: null }),
      '/blog/a': html('<a href="/guides">G</a>', { h1: 'Blog' }),
    })
    expect(result.failures.map((item) => [item.rule, item.page])).toEqual([
      ['h1-count', '/pricing'],
      ['h1-count', '/guides'],
    ])
    expect(result.warnings).toEqual([
      expect.objectContaining({
        rule: 'h1-duplicate',
        message: expect.stringContaining('/blog、/blog/a'),
      }),
    ])
  })

  it('不同语言的相同 h1 不算重复', () => {
    const result = run(
      { ...base, '/zh': html('<a href="/">EN</a>', { h1: 'Home', lang: 'zh' }) },
      { homes: ['/', '/zh'] },
    )
    expect(result.warnings).toEqual([])
  })

  it('点击深度超过阈值只警告', () => {
    const chain: Site = {
      '/': html('<a href="/d1">D1</a>', { h1: 'Home' }),
      '/pricing': html('', { h1: 'Pricing' }),
      '/blog': html('', { h1: 'Blog' }),
      '/guides': html('', { h1: 'Guides' }),
      '/d1': html('<a href="/d2">D2</a>', { h1: 'D1' }),
      '/d2': html('<a href="/d3">D3</a>', { h1: 'D2' }),
      '/d3': html('<a href="/d4">D4</a>', { h1: 'D3' }),
      '/d4': html('', { h1: 'D4' }),
    }
    const result = run(chain)
    expect(result.failures).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({ rule: 'depth', page: '/d4' })])
    expect(result.stats.maxDepth).toBe(4)
  })

  it('有入链但从首页不可达只警告', () => {
    const result = run({
      ...base,
      '/x': html('<a href="/y">Y</a>', { h1: 'X' }),
      '/y': html('<a href="/x">X</a>', { h1: 'Y' }),
    })
    expect(result.failures).toEqual([])
    expect(rules(result.warnings)).toEqual(['unreachable', 'unreachable'])
  })

  it('页头频道数、页脚链接数、钱页入链与 group 正文链接数按阈值警告', () => {
    const footerLinks = Array.from(
      { length: 10 },
      (_, index) => `<a href="/blog">F${index}</a>`,
    ).join('')
    const result = run(
      {
        ...base,
        '/blog/a': html('<div data-link-group="cards"><a href="/guides">Guides</a></div>', {
          h1: 'Post A',
        }).replace('</footer>', `${footerLinks}</footer>`),
      },
      { config: { moneyPages: ['/pricing'] } },
    )
    expect(result.failures).toEqual([])
    expect(result.warnings.map((item) => [item.rule, item.page])).toEqual([
      ['footer-links', '/blog/a'],
      ['group-body-links', '/blog/a'],
    ])
    const money = run(base, {
      config: { moneyPages: ['/pricing'], thresholds: { moneyInlinksMin: 10 } },
    })
    expect(money.warnings).toEqual([
      expect.objectContaining({ rule: 'money-inlinks', page: '/pricing' }),
    ])

    const narrow = run(base, { config: { thresholds: { headerLinksMin: 4 } } })
    expect(new Set(rules(narrow.warnings))).toEqual(new Set(['header-links']))
  })

  it('页面没有导航层区域时单独警告', () => {
    const result = run({
      ...base,
      '/guides': '<html lang="en"><body><h1>Guides</h1><a href="/">Home</a></body></html>',
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({ rule: 'no-nav-zone', page: '/guides' }),
    ])
  })
})

describe('报告与退出码', () => {
  it('report 模式总是 0，enforce 有失败项时为 1', () => {
    const result = run({ ...base, '/lonely': html('', { h1: 'Lonely' }) })
    expect(exitCode(result, 'report')).toBe(0)
    expect(exitCode(result, 'enforce')).toBe(1)
    expect(exitCode(run(base), 'enforce')).toBe(0)
    expect(countByRule(result).failures.orphan).toBe(1)
    expect(formatReport(result, { mode: 'report' })).toContain('orphan: 1')
  })

  it('解析站点地图的 loc', () => {
    expect(
      sitemapLocations(
        '<urlset><url><loc>https://example.com/</loc></url><url><loc> https://example.com/a?x=1&amp;y=2 </loc></url></urlset>',
      ),
    ).toEqual(['https://example.com/', 'https://example.com/a?x=1&y=2'])
  })
})

describe('多站点与语言前缀（planLinkGraphs）', () => {
  // 路由把语言 id 写成小写前缀（与 Paraglide urlPatterns 一致）的项目
  const localize = (locale: string) => (locale === 'en' ? '/' : `/${locale.toLowerCase()}`)
  const i18n = { enabled: true, locales: ['en', 'zh-Hant', 'ja'], defaultLocale: 'en' }

  it('单站点：一张图，语言首页取路由的前缀而不是语言 id', () => {
    expect(planLinkGraphs({ baseUrl: 'http://localhost:4000', i18n, localize })).toEqual([
      {
        host: null,
        origin: 'http://localhost:4000',
        homes: ['/', '/zh-hant', '/ja'],
        localePrefixes: ['zh-hant', 'ja'],
        otherHosts: [],
      },
    ])
    // 关闭多语言时只有默认语言首页；未声明 previewHost 的站点分组不影响抓取
    expect(
      planLinkGraphs({
        baseUrl: 'http://localhost:4000',
        i18n: { ...i18n, enabled: false },
        sites: [{ locales: ['ja'] }],
        localize,
      }).map((graph) => graph.homes),
    ).toEqual([['/']])
  })

  it('多站点：每个 previewHost 各成一图，种子只含本站语言首页，其他站点主机不算站内', () => {
    const graphs = planLinkGraphs({
      baseUrl: 'http://localhost:4000',
      i18n,
      sites: [
        { locales: ['en'], previewHost: 'localhost' },
        { locales: ['zh-Hant', 'ja'], previewHost: 'east.localhost' },
      ],
      localize,
    })
    expect(graphs).toEqual([
      {
        host: 'localhost',
        origin: 'http://localhost:4000',
        homes: ['/'],
        localePrefixes: ['zh-hant', 'ja'],
        otherHosts: ['east.localhost:4000'],
      },
      {
        host: 'east.localhost',
        origin: 'http://east.localhost:4000',
        homes: ['/zh-hant', '/ja'],
        localePrefixes: ['zh-hant', 'ja'],
        otherHosts: ['localhost:4000'],
      },
    ])
  })

  it('钱页统计按路由前缀去掉语言段', () => {
    const page = (path: string, links: string[]) => ({
      path,
      url: `${ORIGIN}${path}`,
      status: 200,
      parsed: parsePage(
        `<html lang="x"><body><header data-link-zone="nav"></header><h1>${path}</h1>${links.map((href) => `<a href="${href}">${href}</a>`).join('')}</body></html>`,
      ),
    })
    const pages = [page('/zh-hant', ['/zh-hant/pricing']), page('/zh-hant/pricing', ['/zh-hant'])]
    const result = analyzeLinkGraph({
      pages,
      targets: new Map(pages.map((item) => [item.path, item])),
      indexable: new Set(pages.map((item) => item.path)),
      homes: ['/zh-hant'],
      internalHosts: HOSTS,
      locales: ['zh-hant'],
      config: resolveLinkingConfig({ moneyPages: ['/pricing'] }),
    })
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ rule: 'money-inlinks', page: '/zh-hant/pricing' }),
    )
  })

  it('单站点保留原始结果和文本报告', () => {
    const one = {
      failures: [{ rule: 'orphan', page: '/a', message: 'x' }],
      warnings: [],
      stats: { pages: 2, links: 3, edges: 1, maxDepth: 1 },
    }
    const result = mergeGraphResults([{ host: null, result: one }])
    expect(result).toBe(one)
    expect(formatReport(result, { mode: 'report' })).toBe(
      [
        '链接图检查（mode=report）：2 页，3 个链接，1 条可索引页之间的边，最大点击深度 1',
        '失败 1 项：',
        '  orphan: 1',
        '    - /a  x',
        '警告 0 项：',
      ].join('\n'),
    )
  })

  it('多站点合并明细与总计，同时按主机报告规则命中和点击深度', () => {
    const finding = { rule: 'orphan', page: '/a', message: 'x' }
    const warning = { rule: 'depth', page: '/b', message: 'y' }
    const one = {
      failures: [finding],
      warnings: [],
      stats: { pages: 2, links: 3, edges: 1, maxDepth: 1 },
    }
    const two = {
      failures: [],
      warnings: [warning],
      stats: { pages: 4, links: 7, edges: 4, maxDepth: 3 },
    }
    const result = mergeGraphResults([
      { host: 'localhost', result: one },
      { host: 'east.localhost', result: two },
    ])
    expect(result).toEqual({
      failures: [{ ...finding, page: 'localhost/a' }],
      warnings: [{ ...warning, page: 'east.localhost/b' }],
      stats: { pages: 6, links: 10, edges: 5, maxDepth: 3 },
      sites: {
        localhost: { pages: 2, links: 3, maxDepth: 1, counts: countByRule(one) },
        'east.localhost': { pages: 4, links: 7, maxDepth: 3, counts: countByRule(two) },
      },
    })
    expect(formatReport(result, { mode: 'report', limit: 0 })).toContain(
      [
        '站点 localhost：2 页，3 个链接，最大点击深度 1',
        '  失败 orphan: 1',
        '  警告 0 项',
        '站点 east.localhost：4 页，7 个链接，最大点击深度 3',
        '  失败 0 项',
        '  警告 depth: 1',
      ].join('\n'),
    )
  })
})
