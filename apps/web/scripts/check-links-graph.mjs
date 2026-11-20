// 构建后链接图检查的纯函数部分（openspec seo-internal-linking design 决策 2、3，tasks 4.1–4.3）。
// HTML 解析、配置合并与规则判断都在这里，便于用固定夹具单测；启动 preview 与抓取由 check-links.mjs 负责。
// 只解析 `<a href>`：按钮、onclick 与脚本跳转不进入链接图（spec「只有真实链接计入链接图」）。
// 默认值、禁用词与配置合并只在 packages/config 维护一份：template.config.ts 已经过 defineTemplateConfig 解析，
// 这里再经 resolveSeoLinking 补全（对已解析的配置结果不变），衍生项目旧配置缺字段时同样取默认值。
import { createHash } from 'node:crypto'
import { defaultBannedAnchors, resolveSeoLinking } from '@saas/config'

/** 失败级与警告级规则；报告按此顺序输出各规则命中数 */
export const FAILURE_RULES = Object.freeze([
  'orphan',
  'dead-link',
  'link-to-noindex',
  'banned-anchor',
  'image-link-alt',
  'sister-nofollow',
  'sister-in-nav',
  'sister-mirror',
  'h1-count',
  // 多语言规则（openspec multilingual-seo design 决策 7，docs/multilingual-seo.md）
  'canonical-self',
  'html-lang',
  'lang-query-link',
  'hreflang-reciprocal',
  'hreflang-cross-host',
  'hreflang-x-default',
  'hreflang-target',
  'accept-language-vary',
  'language-set-cookie',
])
// TODO(multilingual-seo 5.3)：默认语言前缀 301（任务 2.2）与移除 SSR 语言提示（任务 4.1）合并、
// 模板自身通过后，把 `default-locale-prefix` 与 `language-prompt-ssr` 移到 FAILURE_RULES（spec 规定为失败级）。
// 在此之前只警告，避免 CI 的 enforce 检查在这两个改动合并前失败。
export const WARNING_RULES = Object.freeze([
  'h1-duplicate',
  'header-links',
  'group-body-links',
  'depth',
  'unreachable',
  'money-inlinks',
  'footer-links',
  'no-nav-zone',
  'default-locale-prefix',
  'language-prompt-ssr',
])

/** 站内链接中表示语言的查询参数（ML-01：语言只由路径表达） */
export const LANGUAGE_QUERY_PARAMS = Object.freeze(['lang', 'locale', 'language', 'lng', 'hl'])
/** 旧版语言建议使用的偏好 Cookie 名（0.8.0 起移除）；与 Paraglide 的 cookieName 一起视为语言 Cookie */
export const LEGACY_LANGUAGE_COOKIES = Object.freeze(['locale-preference'])

/** 合并项目配置与默认值（`@saas/config` 的 resolveSeoLinking）：非法配置直接报错，不静默回退 */
export function resolveLinkingConfig(raw) {
  return resolveSeoLinking(raw && typeof raw === 'object' ? raw : undefined)
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
// 内容不是 HTML 的元素：其中的 `<a>` 不是真实链接（template 内容惰性、不渲染）
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'template', 'noscript'])
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#x27': "'" }
const TOKEN =
  /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|[^<]+|</g
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)))
    return NAMED_ENTITIES[lower] ?? match
  })
}

function parseAttributes(source) {
  const attributes = {}
  for (const [, name, double, single, bare] of source.matchAll(ATTRIBUTE))
    attributes[name.toLowerCase()] = decodeEntities(double ?? single ?? bare ?? '')
  return attributes
}

const collapse = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * 解析一页 HTML：链接（含区域、锚文本、图片 alt）、h1、语言、canonical、robots、`data-link-group`、
 * hreflang（`<link rel="alternate" hreflang>`）与服务端 HTML 中的语言提示标记数。
 * 区域取最近的 `data-link-zone` 祖先，未标记为 `body`；`region` 是该祖先的标签名，用来区分页头与页脚。
 */
export function parsePage(html) {
  const stack = []
  const links = []
  const h1 = []
  const groups = new Set()
  const alternates = []
  const page = {
    lang: null,
    canonical: null,
    robots: null,
    links,
    h1,
    groups,
    hasNavZone: false,
    alternates,
    languagePrompts: 0,
  }
  let link = null
  let heading = null
  let rawUntil = null
  for (const match of html.matchAll(TOKEN)) {
    const [token, closing, rawName, rawAttributes, selfClosing] = match
    if (rawUntil) {
      if (closing && rawName?.toLowerCase() === rawUntil) rawUntil = null
      continue
    }
    if (!rawName) {
      if (token.startsWith('<!')) continue
      const text = decodeEntities(token)
      if (link) link.text += text
      if (heading !== null) heading += text
      continue
    }
    const name = rawName.toLowerCase()
    if (closing) {
      if (name === 'a' && link) {
        links.push(finishLink(link))
        link = null
      }
      if (name === 'h1' && heading !== null) {
        h1.push(collapse(heading))
        heading = null
      }
      const index = stack.findLastIndex((entry) => entry.name === name)
      if (index >= 0) stack.length = index
      continue
    }
    const attributes = parseAttributes(rawAttributes ?? '')
    if (name === 'html' && attributes.lang) page.lang = attributes.lang
    if (name === 'link' && /(?:^|\s)canonical(?:\s|$)/i.test(attributes.rel ?? ''))
      page.canonical = attributes.href ?? null
    if (
      name === 'link' &&
      /(?:^|\s)alternate(?:\s|$)/i.test(attributes.rel ?? '') &&
      attributes.hreflang &&
      attributes.href
    )
      alternates.push({ hreflang: attributes.hreflang, href: attributes.href })
    // 服务端 HTML 中的语言提示（ML-03）：新提示条的标记与旧版建议横幅的 data-locale-suggestion*
    if (
      Object.keys(attributes).some(
        (key) => key === 'data-language-prompt' || key.startsWith('data-locale-suggestion'),
      )
    )
      page.languagePrompts += 1
    if (name === 'meta' && attributes.name?.toLowerCase() === 'robots')
      page.robots = attributes.content ?? null
    if ('data-link-group' in attributes && attributes['data-link-group'])
      groups.add(attributes['data-link-group'])
    if (attributes['data-link-zone'] === 'nav') page.hasNavZone = true
    if (RAW_TEXT_ELEMENTS.has(name)) {
      if (!selfClosing) rawUntil = name
      continue
    }
    if (name === 'img' && link) link.images.push(attributes.alt ?? null)
    if (name === 'a' && attributes.href !== undefined) {
      if (link) links.push(finishLink(link))
      // 链接自身的 data-link-zone（如转化按钮 action）优先于祖先区域
      const zoneEntry = attributes['data-link-zone']
        ? { name: 'a', zone: attributes['data-link-zone'] }
        : stack.findLast((entry) => entry.zone)
      link = {
        href: attributes.href,
        rel: (attributes.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean),
        ariaLabel: attributes['aria-label'] ?? null,
        zone: zoneEntry?.zone ?? 'body',
        region: zoneEntry?.name ?? null,
        inNav: stack.some((entry) => entry.name === 'nav'),
        text: '',
        images: [],
      }
    }
    if (name === 'h1' && heading === null) heading = ''
    if (!selfClosing && !VOID_ELEMENTS.has(name))
      stack.push({ name, zone: attributes['data-link-zone'] ?? null })
  }
  if (link) links.push(finishLink(link))
  return { ...page, groups: [...groups] }
}

function finishLink(link) {
  const text = collapse(link.text)
  const imageOnly = text === '' && link.images.length > 0
  const alts = link.images.map((alt) => collapse(alt ?? '')).filter(Boolean)
  return {
    href: link.href,
    rel: link.rel,
    zone: link.zone,
    region: link.region,
    inNav: link.inNav,
    text,
    imageOnly,
    imageAltMissing: imageOnly && link.images.some((alt) => !collapse(alt ?? '')),
    anchor: text || alts.join(' ') || collapse(link.ariaLabel ?? ''),
  }
}

/**
 * 「链接到不可索引页」豁免的区域（design.md 决策 3）：nav 导航层（登录、账户入口），
 * action 转化入口（注册、进入应用的 CTA 与悬浮 AI 入口，不参与正文链接计数）
 */
export const LINK_TO_NOINDEX_EXEMPT = new Set(['nav', 'action'])

/** 规范化站内路径：去掉 hash 与末尾斜杠，保留查询参数（带查询参数的地址视为不可索引） */
export function normalizePath(pathname, search = '') {
  const path = pathname.replace(/\/+$/, '') || '/'
  return `${path}${search}`
}

/**
 * 把 href 解析为站内路径或站外地址。`internalHosts` 为本站地址（preview 地址、站点地图与 app.url 的 host）。
 * 返回 null 表示不是可抓取的链接（mailto、tel、javascript、纯锚点）。
 */
export function classifyHref(href, pageUrl, internalHosts) {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  let url
  try {
    url = new URL(trimmed, pageUrl)
  } catch {
    return { kind: 'invalid', href: trimmed }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (internalHosts.has(url.host))
    return { kind: 'internal', path: normalizePath(url.pathname, url.search) }
  return { kind: 'external', host: url.hostname.toLowerCase(), path: normalizePath(url.pathname) }
}

const ANCHOR_DECORATION = /^[\s←→›»«‹>…:：.。!！?？]+|[\s←→›»«‹>…:：.。!！?？]+$/g

function normalizeAnchor(text) {
  return text.replace(ANCHOR_DECORATION, '').replace(/\s+/g, ' ').toLowerCase()
}

function isSister(host, sisterDomains) {
  return sisterDomains.some((domain) => {
    const normalized = String(domain)
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    return host === normalized || host.endsWith(`.${normalized}`)
  })
}

function delocalize(path, prefixes) {
  const [, first = '', ...rest] = path.split('/')
  return prefixes.includes(first) ? `/${rest.join('/')}`.replace(/\/$/, '') || '/' : path
}

/**
 * 链接图的抓取计划（docs/seo-internal-linking.md「多站点」）。`localize(locale)` 返回该语言首页的 path，
 * 须与路由的语言前缀一致（check-links.mjs 用 Paraglide 运行时的 localizeUrl，路由前缀不是语言 id 本身时也正确）。
 * - 没有站点声明 `previewHost`（模板默认）：整个 preview 为一张图，种子含全部语言首页；
 * - 否则每个声明了 `previewHost` 的站点各成一张图：以 `<previewHost>:<preview 端口>` 访问，种子只含该站点语言的首页，
 *   其他站点的主机不算站内（指向它们的链接不跟随、不并入本图）。
 * `localePrefixes` 是全部语言首页的首段（如 `zh`），钱页统计据此去掉语言前缀。
 */
export function planLinkGraphs({ baseUrl, i18n, sites = [], localize }) {
  const locales = i18n?.enabled === false ? [i18n.defaultLocale] : (i18n?.locales ?? [])
  const homesOf = (list) =>
    list.length ? [...new Set(list.map((locale) => normalizePath(localize(locale))))] : ['/']
  const localePrefixes = locales
    .map((locale) => normalizePath(localize(locale)).split('/')[1])
    .filter(Boolean)
  const base = new URL(baseUrl)
  const checked = sites.filter((site) => site.previewHost)
  if (checked.length === 0)
    return [
      { host: null, origin: base.origin, homes: homesOf(locales), localePrefixes, otherHosts: [] },
    ]
  const originOf = (host) => {
    const url = new URL(base.origin)
    url.hostname = host
    return url.origin
  }
  return checked.map((site) => ({
    host: site.previewHost,
    origin: originOf(site.previewHost),
    homes: homesOf(site.locales.filter((locale) => locales.includes(locale))),
    localePrefixes,
    otherHosts: checked
      .filter((other) => other !== site)
      .map((other) => new URL(originOf(other.previewHost)).host),
  }))
}

/** 多站点保留各站点的摘要，明细带主机名；汇总统计求和，最大深度取最大值 */
export function mergeGraphResults(entries) {
  if (entries.length === 1 && entries[0].host === null) return entries[0].result
  const label = (host, items) => items.map((item) => ({ ...item, page: `${host}${item.page}` }))
  return {
    failures: entries.flatMap(({ host, result }) => label(host, result.failures)),
    warnings: entries.flatMap(({ host, result }) => label(host, result.warnings)),
    stats: {
      pages: entries.reduce((sum, { result }) => sum + result.stats.pages, 0),
      links: entries.reduce((sum, { result }) => sum + result.stats.links, 0),
      edges: entries.reduce((sum, { result }) => sum + result.stats.edges, 0),
      maxDepth: Math.max(0, ...entries.map(({ result }) => result.stats.maxDepth)),
    },
    sites: Object.fromEntries(
      entries.map(({ host, result }) => {
        const { pages, links, maxDepth } = result.stats
        return [host, { pages, links, maxDepth, counts: countByRule(result) }]
      }),
    ),
  }
}

/**
 * 指向站点地图之外地址的链接是否允许出现在正文：回退页（canonical 指向另一个可索引地址、未设 noindex）可以链接，
 * 其余（应用区、账户、后台、分享页、带查询参数的地址、noindex 页）都视为不可索引。
 */
function isAliasOfIndexable(target, indexable, internalHosts) {
  if (!target || target.status >= 400 || !target.canonical) return false
  if (/noindex/i.test(target.robots ?? '')) return false
  const canonical = classifyHref(target.canonical, target.url, internalHosts)
  return canonical?.kind === 'internal' && indexable.has(canonical.path)
}

/**
 * 按规则检查链接图。
 * - `pages`：抓取到的可索引页面（站点地图地址与各语言首页），`{ path, url, status, parsed }`；
 * - `targets`：所有站内链接目标的抓取结果，`Map<path, { url, status, canonical, robots }>`；
 * - `indexable`：站点地图中的路径集合；`homes`：各语言首页路径；
 * - `internalHosts`：本站 host 集合；`locales`：语言前缀（URL 首段，见 planLinkGraphs 的 `localePrefixes`）。
 * 返回失败与警告明细，以及链接图统计。
 */
export function analyzeLinkGraph({
  pages,
  targets,
  indexable,
  homes,
  internalHosts,
  locales = [],
  config,
}) {
  const failures = []
  const warnings = []
  // 同一页对同一目标的重复链接（如多个 CTA）只报一次
  const reported = new Set()
  const fail = (rule, page, message, target) => {
    const key = `${rule}\n${page}\n${message}`
    if (reported.has(key)) return
    reported.add(key)
    failures.push({ rule, page, target, message })
  }
  const warn = (rule, page, message, target) => warnings.push({ rule, page, target, message })
  // 多语言规则按所在级别（FAILURE_RULES／WARNING_RULES）报告，便于暂缓的规则只改清单
  const flag = (rule, page, message, target) =>
    FAILURE_RULES.includes(rule)
      ? fail(rule, page, message, target)
      : warn(rule, page, message, target)
  const banned = new Set(
    [...defaultBannedAnchors, ...config.bannedAnchors].map((word) => normalizeAnchor(word)),
  )
  const { thresholds } = config
  const inlinks = new Map()
  const edges = new Map()
  const h1ByLocale = new Map()
  let linkCount = 0

  for (const page of pages) {
    const { parsed } = page
    if (page.status >= 400 || !parsed) {
      fail('dead-link', page.path, `可索引页返回 ${page.status}`)
      continue
    }
    const out = new Set()
    let headerLinks = 0
    let headerNavLinks = 0
    let footerLinks = 0
    let bodyLinks = 0
    checkPageLanguage(page, indexable, internalHosts, flag)
    for (const link of parsed.links) {
      if (link.imageAltMissing)
        fail('image-link-alt', page.path, `只含图片的链接缺少 alt：${link.href}`, link.href)
      const target = classifyHref(link.href, page.url, internalHosts)
      if (!target) continue
      linkCount += 1
      if (link.zone === 'nav' && link.region === 'header') {
        headerLinks += 1
        if (link.inNav) headerNavLinks += 1
      }
      if (link.zone === 'nav' && link.region === 'footer') footerLinks += 1
      if (target.kind === 'external') {
        if (!isSister(target.host, config.sisterDomains)) continue
        if (!link.rel.includes('nofollow'))
          fail(
            'sister-nofollow',
            page.path,
            `姊妹站链接缺少 rel="nofollow"：${link.href}`,
            link.href,
          )
        if (link.zone === 'nav')
          fail(
            'sister-in-nav',
            page.path,
            `导航层（页头、页脚、面包屑）出现姊妹站链接：${link.href}`,
            link.href,
          )
        if (target.path === page.path)
          fail(
            'sister-mirror',
            page.path,
            `姊妹站链接指向相同路径的镜像页：${link.href}`,
            link.href,
          )
        continue
      }
      if (target.kind === 'invalid') {
        fail('dead-link', page.path, `无法解析的链接：${link.href}`, link.href)
        continue
      }
      if (languageQuery(link.href, page.url))
        flag(
          'lang-query-link',
          page.path,
          `站内链接使用语言查询参数：${link.href}（语言只由路径前缀表达）`,
          target.path,
        )
      if (link.zone === 'body') bodyLinks += 1
      if (banned.has(normalizeAnchor(link.anchor)))
        fail(
          'banned-anchor',
          page.path,
          `禁用锚文本「${link.anchor}」→ ${target.path}`,
          target.path,
        )
      const status = targets.get(target.path)
      if (!status || status.status >= 400) {
        fail(
          'dead-link',
          page.path,
          `死链 ${target.path}（${status?.status ?? '无响应'}）`,
          target.path,
        )
        continue
      }
      if (target.path === page.path) continue
      if (indexable.has(target.path)) {
        out.add(target.path)
        if (!inlinks.has(target.path)) inlinks.set(target.path, new Set())
        inlinks.get(target.path).add(page.path)
      } else if (
        !LINK_TO_NOINDEX_EXEMPT.has(link.zone) &&
        !isAliasOfIndexable(status, indexable, internalHosts)
      ) {
        fail(
          'link-to-noindex',
          page.path,
          `${link.zone === 'body' ? '正文' : `区块（${link.zone}）`}链接到不可索引页 ${target.path}`,
          target.path,
        )
      }
    }
    edges.set(page.path, out)

    if (!parsed.hasNavZone)
      warn('no-nav-zone', page.path, '页面没有 data-link-zone="nav" 区域，导航层判断可能失效')
    if (parsed.h1.length !== 1)
      fail('h1-count', page.path, `<h1> 数量为 ${parsed.h1.length}，应恰好一个`)
    const locale = parsed.lang ?? ''
    for (const text of new Set(parsed.h1)) {
      if (!h1ByLocale.has(locale)) h1ByLocale.set(locale, new Map())
      const byText = h1ByLocale.get(locale)
      byText.set(text, [...(byText.get(text) ?? []), page.path])
    }
    const channels = headerNavLinks || headerLinks
    if (
      parsed.hasNavZone &&
      (channels < thresholds.headerLinksMin || channels > thresholds.headerLinksMax)
    )
      warn(
        'header-links',
        page.path,
        `页头频道链接 ${channels} 个，不在 ${thresholds.headerLinksMin}–${thresholds.headerLinksMax}`,
      )
    if (footerLinks > thresholds.footerLinksMax)
      warn(
        'footer-links',
        page.path,
        `页脚链接 ${footerLinks} 个，超过 ${thresholds.footerLinksMax}`,
      )
    if (parsed.groups.length > 0 && bodyLinks < thresholds.groupBodyLinksMin)
      warn(
        'group-body-links',
        page.path,
        `声明了 group 的详情页正文链接 ${bodyLinks} 个，少于 ${thresholds.groupBodyLinksMin}`,
      )
  }

  for (const [locale, byText] of h1ByLocale)
    for (const [text, paths] of byText)
      if (paths.length > 1)
        warn(
          'h1-duplicate',
          paths[0],
          `「${text}」在 ${locale || '未标注语言'} 中重复：${paths.join('、')}`,
        )

  checkHreflang({ pages, targets, indexable, internalHosts, flag })

  // 点击深度：从各语言首页同时出发的最短路径（语言切换也是真实链接）
  const depth = new Map(homes.filter((home) => edges.has(home)).map((home) => [home, 0]))
  const queue = [...depth.keys()]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const next of edges.get(current) ?? []) {
      if (depth.has(next)) continue
      depth.set(next, depth.get(current) + 1)
      queue.push(next)
    }
  }

  const checked = new Set(
    pages.filter((page) => page.parsed && page.status < 400).map((page) => page.path),
  )
  const moneyPages = new Set(config.moneyPages.map((path) => normalizePath(path)))
  for (const path of checked) {
    const sources = inlinks.get(path)?.size ?? 0
    if (sources === 0) fail('orphan', path, '没有任何站内页面链接到该页（站点地图不计）')
    else if (!depth.has(path)) warn('unreachable', path, '从首页出发无法经链接到达')
    else if (depth.get(path) > thresholds.maxDepth)
      warn('depth', path, `点击深度 ${depth.get(path)}，超过 ${thresholds.maxDepth}`)
    if (moneyPages.has(delocalize(path, locales)) && sources < thresholds.moneyInlinksMin)
      warn('money-inlinks', path, `钱页站内入链 ${sources} 个，少于 ${thresholds.moneyInlinksMin}`)
  }

  return {
    failures,
    warnings,
    stats: {
      pages: pages.length,
      links: linkCount,
      edges: [...edges.values()].reduce((sum, set) => sum + set.size, 0),
      maxDepth: Math.max(0, ...depth.values()),
    },
  }
}

/** 链接中的语言查询参数名（如 `?lang=zh`），没有时为 null */
export function languageQuery(href, pageUrl) {
  try {
    const { searchParams } = new URL(href, pageUrl)
    return (
      [...searchParams.keys()].find((key) => LANGUAGE_QUERY_PARAMS.includes(key.toLowerCase())) ??
      null
    )
  } catch {
    return null
  }
}

/**
 * 单页多语言规则：可索引页 canonical 指向自身；`<html lang>` 与本页在 hreflang 组中的语言一致；
 * 服务端 HTML 中没有语言提示。canonical 缺失不算失败（搜索引擎按自身处理）；canonical 指向别处的回退页
 * 不进站点地图（design.md 决策 7），所以这里只检查站点地图中的页面。
 */
function checkPageLanguage(page, indexable, internalHosts, flag) {
  const { parsed } = page
  if (indexable.has(page.path) && parsed.canonical && !/noindex/i.test(parsed.robots ?? '')) {
    const canonical = classifyHref(parsed.canonical, page.url, internalHosts)
    if (canonical?.kind !== 'internal' || canonical.path !== page.path)
      flag(
        'canonical-self',
        page.path,
        `可索引页的 canonical 指向 ${parsed.canonical}，应指向本页`,
        parsed.canonical,
      )
  }
  if (parsed.languagePrompts > 0)
    flag(
      'language-prompt-ssr',
      page.path,
      `服务端 HTML 中有 ${parsed.languagePrompts} 个语言提示元素（data-language-prompt／data-locale-suggestion*），提示应在水合后挂载`,
    )
  const self = parsed.alternates.find((entry) => {
    if (entry.hreflang.toLowerCase() === 'x-default') return false
    const target = classifyHref(entry.href, page.url, internalHosts)
    return target?.kind === 'internal' && target.path === page.path
  })
  if (self && self.hreflang.toLowerCase() !== (parsed.lang ?? '').toLowerCase())
    flag(
      'html-lang',
      page.path,
      `<html lang="${parsed.lang ?? ''}"> 与本页 hreflang「${self.hreflang}」不一致`,
    )
}

/**
 * hreflang 图规则：同域、x-default 恰好一条、目标可访问且可索引、包含本页并与各语言版本双向互指。
 * 只检查声明了 hreflang 的页面（关闭多语言的项目没有 hreflang）。
 */
function checkHreflang({ pages, targets, indexable, internalHosts, flag }) {
  const groups = new Map()
  const parsedPaths = new Set(
    pages.filter((page) => page.status < 400 && page.parsed).map((page) => page.path),
  )
  for (const page of pages) {
    if (page.status >= 400 || !page.parsed?.alternates.length) continue
    groups.set(
      page.path,
      page.parsed.alternates.map((entry) => ({
        ...entry,
        target: classifyHref(entry.href, page.url, internalHosts),
      })),
    )
  }
  for (const [path, entries] of groups) {
    const defaults = entries.filter((entry) => entry.hreflang.toLowerCase() === 'x-default')
    if (defaults.length !== 1)
      flag('hreflang-x-default', path, `x-default 有 ${defaults.length} 条，应恰好一条`)
    let hasSelf = false
    for (const { hreflang, href, target } of entries) {
      if (target?.kind !== 'internal') {
        flag(
          target?.kind === 'external' ? 'hreflang-cross-host' : 'hreflang-target',
          path,
          `hreflang「${hreflang}」指向${target?.kind === 'external' ? '其他域名' : '无法解析的地址'} ${href}`,
          href,
        )
        continue
      }
      const fetched = targets.get(target.path)
      if (!fetched || fetched.status >= 400) {
        flag(
          'hreflang-target',
          path,
          `hreflang「${hreflang}」指向不可访问的地址 ${target.path}（${fetched?.status ?? '无响应'}）`,
          target.path,
        )
        continue
      }
      if (!indexable.has(target.path)) {
        flag(
          'hreflang-target',
          path,
          `hreflang「${hreflang}」指向不可索引的地址 ${target.path}（不在站点地图中）`,
          target.path,
        )
        continue
      }
      if (hreflang.toLowerCase() === 'x-default') continue
      if (target.path === path) {
        hasSelf = true
        continue
      }
      // 对方页也在本次抓取中（可索引页都会抓取）时才能判断回指；没有 hreflang 的页面视为空组
      if (!parsedPaths.has(target.path)) continue
      const back = groups.get(target.path) ?? []
      // x-default 不算回指：对方必须以某个语言代码列出本页
      const listed = back.some(
        (entry) =>
          entry.hreflang.toLowerCase() !== 'x-default' &&
          entry.target?.kind === 'internal' &&
          entry.target.path === path,
      )
      if (!listed)
        flag(
          'hreflang-reciprocal',
          path,
          `hreflang「${hreflang}」列出 ${target.path}，但该页的 hreflang 没有列出本页`,
          target.path,
        )
    }
    if (!hasSelf) flag('hreflang-reciprocal', path, 'hreflang 组没有列出本页自身')
  }
}

/** Accept-Language 对比使用的两种请求头（ML-05：公开页不按浏览器语言改变响应） */
export const ACCEPT_LANGUAGE_VARIANTS = Object.freeze(['zh-CN,zh;q=0.9', 'en-US,en;q=0.9'])

/**
 * 规范化正文用于对比，去掉每次请求都不同、与语言无关的部分：
 * - CSP nonce：属性中的取值，以及同一取值在水合数据等处的出现；
 * - 毫秒时间戳（13 位数字，如路由水合数据中的 `u:1795181709237`）。
 * 其余原样保留。预渲染页面逐字节相同；按请求渲染的页面（如定价页）规范化后相同。
 */
export function normalizeBody(html) {
  const nonces = new Set(
    [...html.matchAll(/\snonce=["']?([^"'\s>]+)/gi)].map(([, value]) => value).filter(Boolean),
  )
  let body = html
  for (const nonce of nonces) body = body.split(nonce).join('')
  return body.replace(/(?<![\w.-])1\d{12}(?![\w.-])/g, '0')
}

/** 一次请求的对比摘要：状态、Location、`<html lang>` 与规范化正文的 SHA-256 */
export function responseSignature({ status, location = null, body = null }) {
  return {
    status,
    location: location ?? null,
    lang: body === null ? null : (/<html\b[^>]*\slang=["']?([^"'\s>]+)/i.exec(body)?.[1] ?? null),
    digest: body === null ? null : createHash('sha256').update(normalizeBody(body)).digest('hex'),
  }
}

/**
 * 以不同 Accept-Language 请求同一地址的结果是否一致（spec「按浏览器语言跳转」）。
 * `responses` 为 `{ acceptLanguage, status, location, body }`，返回 `accept-language-vary` 发现项。
 */
export function compareAcceptLanguage(path, responses) {
  const [first, ...rest] = responses.map((response) => ({
    acceptLanguage: response.acceptLanguage,
    ...responseSignature(response),
  }))
  const findings = []
  for (const other of rest)
    for (const [field, label] of [
      ['status', '状态码'],
      ['location', 'Location'],
      ['lang', '<html lang>'],
      ['digest', '正文'],
    ])
      if (first[field] !== other[field]) {
        const detail =
          field === 'digest' ? '规范化正文摘要不同' : `${first[field]} ≠ ${other[field]}`
        findings.push({
          rule: 'accept-language-vary',
          page: path,
          message: `Accept-Language「${first.acceptLanguage}」与「${other.acceptLanguage}」的${label}不同：${detail}`,
        })
        break
      }
  return findings
}

/**
 * 从 `Set-Cookie` 列表中找出语言相关的 Cookie 名：名称在 `names` 中（Paraglide cookieName、旧偏好 Cookie、
 * 项目配置）、名称含 lang／locale，或值就是某个语言 id。
 */
export function languageCookies(setCookies, { names = [], locales = [] } = {}) {
  const known = new Set(names.map((name) => name.toLowerCase()))
  const localeIds = new Set(locales.map((locale) => locale.toLowerCase()))
  const found = []
  for (const header of setCookies) {
    const [pair = ''] = header.split(';')
    const index = pair.indexOf('=')
    const name = (index < 0 ? pair : pair.slice(0, index)).trim()
    const value =
      index < 0
        ? ''
        : pair
            .slice(index + 1)
            .trim()
            .replace(/^"|"$/g, '')
    if (!name) continue
    if (
      known.has(name.toLowerCase()) ||
      /lang|locale/i.test(name) ||
      localeIds.has(value.toLowerCase())
    )
      found.push(name)
  }
  return [...new Set(found)]
}

/**
 * 默认语言前缀（ML-02：默认语言只有一套地址）：`/<默认语言>/…` 应 301 到无前缀地址。
 * `location` 按 `url` 解析后只比较 path；返回 `default-locale-prefix` 发现项或 null。
 */
export function checkDefaultPrefix({ path, expected, url, status, location }) {
  const target = location ? new URL(location, url) : null
  const actual = target ? normalizePath(target.pathname, target.search) : null
  if (status === 301 && actual === expected) return null
  return {
    rule: 'default-locale-prefix',
    page: path,
    target: expected,
    message: `${path} 返回 ${status}${actual ? ` → ${actual}` : ''}，应 301 到 ${expected}`,
  }
}

/**
 * Accept-Language 对比的地址：语言首页必测，其余从可索引页中等距抽取至多 `samples` 个（结果确定，便于复现）。
 */
export function acceptLanguagePaths({ homes, indexable, samples }) {
  const rest = [...indexable].filter((path) => !homes.includes(path) && !path.includes('?')).sort()
  const count = Math.min(Math.max(0, samples), rest.length)
  const picked = Array.from(
    { length: count },
    (_, index) => rest[Math.floor((index * rest.length) / count)],
  )
  return [...new Set([...homes, ...picked])]
}

/** 把检查脚本按 HTTP 得到的多语言发现项按规则级别并入结果（同一规则、页面与说明只记一次） */
export function addFindings(result, findings) {
  const keyOf = (item) => `${item.rule}\n${item.page}\n${item.message}`
  const seen = new Set([...result.failures, ...result.warnings].map(keyOf))
  for (const finding of findings) {
    if (seen.has(keyOf(finding))) continue
    seen.add(keyOf(finding))
    if (FAILURE_RULES.includes(finding.rule)) result.failures.push(finding)
    else result.warnings.push(finding)
  }
  return result
}

/** 各规则命中数，按失败级、警告级的固定顺序 */
export function countByRule(result) {
  const count = (items, rules) =>
    Object.fromEntries(
      rules.map((rule) => [rule, items.filter((item) => item.rule === rule).length]),
    )
  return {
    failures: count(result.failures, FAILURE_RULES),
    warnings: count(result.warnings, WARNING_RULES),
  }
}

/** 文本报告：各规则命中数与每条规则最多 `limit` 条明细，多站点附各站点摘要 */
export function formatReport(result, { mode, limit = 20 } = {}) {
  const counts = countByRule(result)
  const lines = [
    `链接图检查（mode=${mode}）：${result.stats.pages} 页，${result.stats.links} 个链接，` +
      `${result.stats.edges} 条可索引页之间的边，最大点击深度 ${result.stats.maxDepth}`,
  ]
  for (const [level, items, rules] of [
    ['失败', result.failures, FAILURE_RULES],
    ['警告', result.warnings, WARNING_RULES],
  ]) {
    lines.push(`${level} ${items.length} 项：`)
    for (const rule of rules) {
      const hits = items.filter((item) => item.rule === rule)
      const total = level === '失败' ? counts.failures[rule] : counts.warnings[rule]
      if (total === 0) continue
      lines.push(`  ${rule}: ${total}`)
      for (const item of hits.slice(0, limit)) lines.push(`    - ${item.page}  ${item.message}`)
      if (hits.length > limit) lines.push(`    … 另有 ${hits.length - limit} 条`)
    }
  }
  for (const [host, { pages, links, maxDepth, counts }] of Object.entries(result.sites ?? {})) {
    lines.push(`站点 ${host}：${pages} 页，${links} 个链接，最大点击深度 ${maxDepth}`)
    for (const [level, rules] of [
      ['失败', counts.failures],
      ['警告', counts.warnings],
    ]) {
      const hits = Object.entries(rules)
        .filter(([, count]) => count > 0)
        .map(([rule, count]) => `${rule}: ${count}`)
      lines.push(`  ${level} ${hits.join('，') || '0 项'}`)
    }
  }
  return lines.join('\n')
}

/** 退出码：enforce 模式下有失败项时为 1 */
export function exitCode(result, mode) {
  return mode === 'enforce' && result.failures.length > 0 ? 1 : 0
}

/** 解析站点地图（urlset 或 sitemapindex）中的全部 `<loc>` */
export function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(([, loc]) => decodeEntities(loc))
}
