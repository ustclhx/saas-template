// 构建后链接图检查的纯函数部分（openspec seo-internal-linking design 决策 2、3，tasks 4.1–4.3）。
// HTML 解析、配置合并与规则判断都在这里，便于用固定夹具单测；启动 preview 与抓取由 check-links.mjs 负责。
// 只解析 `<a href>`：按钮、onclick 与脚本跳转不进入链接图（spec「只有真实链接计入链接图」）。

/** 规范要求的默认禁用锚文本；项目配置的 `bannedAnchors` 只做增补 */
export const BUILTIN_BANNED_ANCHORS = Object.freeze([
  '点击这里',
  '了解更多',
  '查看详情',
  'here',
  'read more',
  'learn more',
])

/**
 * `seo.linking` 的默认值（字段名照 design 决策 5）。类型与默认值的权威来源将是 `packages/config`；
 * 在它合并前，检查脚本用这份默认值与 template config 中的 `seo?.linking` 合并，未配置时为 report。
 */
export const DEFAULT_LINKING = Object.freeze({
  mode: 'report',
  bannedAnchors: Object.freeze([]),
  moneyPages: Object.freeze([]),
  sisterDomains: Object.freeze([]),
  series: Object.freeze([]),
  hubPageSize: 100,
  thresholds: Object.freeze({
    headerLinksMin: 3,
    headerLinksMax: 7,
    groupBodyLinksMin: 2,
    maxDepth: 3,
    moneyInlinksMin: 3,
    footerLinksMax: 10,
  }),
})

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
])
export const WARNING_RULES = Object.freeze([
  'h1-duplicate',
  'header-links',
  'group-body-links',
  'depth',
  'unreachable',
  'money-inlinks',
  'footer-links',
  'no-nav-zone',
])

/** 合并项目配置与默认值：数组整体替换，阈值逐项覆盖，未知或非法的 mode 回退 report */
export function resolveLinkingConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const list = (value, fallback) => (Array.isArray(value) ? [...value] : [...fallback])
  return {
    mode: input.mode === 'enforce' ? 'enforce' : 'report',
    bannedAnchors: list(input.bannedAnchors, DEFAULT_LINKING.bannedAnchors),
    moneyPages: list(input.moneyPages, DEFAULT_LINKING.moneyPages),
    sisterDomains: list(input.sisterDomains, DEFAULT_LINKING.sisterDomains),
    series: list(input.series, DEFAULT_LINKING.series),
    hubPageSize:
      typeof input.hubPageSize === 'number' ? input.hubPageSize : DEFAULT_LINKING.hubPageSize,
    thresholds: { ...DEFAULT_LINKING.thresholds, ...(input.thresholds ?? {}) },
  }
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
 * 解析一页 HTML：链接（含区域、锚文本、图片 alt）、h1、语言、canonical、robots 与 `data-link-group`。
 * 区域取最近的 `data-link-zone` 祖先，未标记为 `body`；`region` 是该祖先的标签名，用来区分页头与页脚。
 */
export function parsePage(html) {
  const stack = []
  const links = []
  const h1 = []
  const groups = new Set()
  const page = { lang: null, canonical: null, robots: null, links, h1, groups, hasNavZone: false }
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
      const zoneEntry = stack.findLast((entry) => entry.zone)
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

function delocalize(path, locales) {
  const [, first = '', ...rest] = path.split('/')
  return locales.includes(first) ? `/${rest.join('/')}`.replace(/\/$/, '') || '/' : path
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
 * - `internalHosts`：本站 host 集合；`locales`：模板语言列表。
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
  const banned = new Set(
    [...BUILTIN_BANNED_ANCHORS, ...config.bannedAnchors].map((word) => normalizeAnchor(word)),
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
      } else if (link.zone !== 'nav' && !isAliasOfIndexable(status, indexable, internalHosts)) {
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

/** 文本报告：各规则命中数与每条规则最多 `limit` 条明细 */
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
