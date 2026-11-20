// 构建后链接图检查（openspec seo-internal-linking design 决策 2，tasks 4.1–4.2）。
// 启动 `vite preview` 运行构建产物，以站点地图全部地址加各语言首页为种子按 HTTP 抓取，解析 `<a href>` 构建站内链接图，
// 规则见 check-links-graph.mjs。只读构建产物与模板配置，不依赖 publicPages() 的实现。
//
// 同一次运行还检查多语言规则（openspec multilingual-seo design 决策 7）：页面级与 hreflang 规则在
// check-links-graph.mjs，这里补充需要额外请求的三项——Accept-Language 对比、公开页语言 Set-Cookie、默认语言前缀 301。
//
// 用法（先 `pnpm build`）：pnpm --filter @saas/web check:links [--mode report|enforce] [--json <文件>] [--limit <条数>]
//   --base-url <地址>：检查已在运行的服务，不启动 preview。
//   --accept-language-samples <n>：除各语言首页外，抽样做 Accept-Language 对比的可索引页数（默认 3）。
// report 只报告并以 0 退出；enforce 有失败项时以 1 退出。未传 --mode 时取 template config 的 seo.linking.mode。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ACCEPT_LANGUAGE_VARIANTS,
  acceptLanguagePaths,
  addFindings,
  analyzeLinkGraph,
  checkDefaultPrefix,
  classifyHref,
  compareAcceptLanguage,
  countByRule,
  exitCode,
  formatReport,
  LEGACY_LANGUAGE_COOKIES,
  languageCookies,
  mergeGraphResults,
  parsePage,
  planLinkGraphs,
  resolveLinkingConfig,
  sitemapLocations,
} from './check-links-graph.mjs'
import { fallbackDevVars } from './prerender-env.ts'

const WEB_ROOT = new URL('..', import.meta.url).pathname
const CONCURRENCY = 8
const START_TIMEOUT_MS = 60_000
const ACCEPT = 'text/html,*/*'
const DEFAULT_ACCEPT_LANGUAGE_SAMPLES = 3

async function loadTemplateConfig() {
  // template.config.ts 由 Node 的类型剥离加载（Node ≥22.18 默认开启）；加载失败时直接报错，
  // 不静默回退默认值，避免 enforce 配置在 CI 中被悄悄降级为 report。
  const module = await import(new URL('../../../template.config.ts', import.meta.url).href)
  return module.default
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

/** 与构建期预渲染相同：`vite preview` 在 workerd 中运行 dist 产物；只结束自己启动的进程组 */
async function startPreview() {
  if (!existsSync(resolve(WEB_ROOT, 'dist/server/index.js')))
    throw new Error('缺少构建产物 apps/web/dist，请先运行 pnpm --filter @saas/web build')
  // Turbo 缓存命中恢复的产物不含 .dev.vars（刻意不缓存），没有它时 Worker 启动校验让所有页面返回 500；
  // 与构建期预渲染一样补一份示例值，检查结束后删除
  const devVars = resolve(WEB_ROOT, 'dist/server/.dev.vars')
  let wroteDevVars = false
  if (!existsSync(devVars)) {
    const source = fallbackDevVars()
    if (source !== null) {
      writeFileSync(devVars, source, { mode: 0o600 })
      wroteDevVars = true
    }
  }
  const removeDevVars = () => {
    if (wroteDevVars) rmSync(devVars, { force: true })
  }
  const port = await freePort()
  const child = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: WEB_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  let log = ''
  const keep = (chunk) => {
    log = (log + chunk).slice(-8000)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  const stop = () => {
    removeDevVars()
    if (child.exitCode !== null) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // 进程组已退出
    }
  }
  const baseUrl = `http://localhost:${port}`
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      removeDevVars()
      throw new Error(`vite preview 已退出（${child.exitCode}）：\n${log}`)
    }
    try {
      const response = await fetch(`${baseUrl}/`, { redirect: 'manual' })
      if (response.status < 500) return { baseUrl, stop }
    } catch {
      // 尚未监听
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  stop()
  throw new Error(`vite preview 在 ${START_TIMEOUT_MS / 1000} 秒内未就绪：\n${log}`)
}

/**
 * 语言首页的 path 与路由一致：取 Paraglide 编译出的运行时（typecheck / build 生成），项目改了 URL 前缀
 * （如小写 `/zh-hant`）也不会误报死链。运行时缺失时退回 `/<语言 id>` 并提示。
 * 同时取运行时的 `cookieName`，用于识别公开页响应中的语言 Cookie。
 */
async function loadRuntime(i18n) {
  try {
    const runtime = await import(new URL('../src/paraglide/runtime.js', import.meta.url).href)
    return {
      localize: (locale) => runtime.localizeUrl('http://localhost/', { locale }).pathname,
      cookieName: runtime.cookieName,
    }
  } catch (error) {
    console.warn(`未能加载 Paraglide 运行时，语言首页按 /<语言 id> 推算：${error}`)
    return {
      localize: (locale) => (locale === i18n?.defaultLocale ? '/' : `/${locale}`),
      cookieName: undefined,
    }
  }
}

/** 普通 HTTP 请求；不跟随重定向，由 fetchPage 逐跳处理。`headers` 追加请求头（如 Accept-Language） */
export async function fetchRequest(url, headers = {}) {
  const response = await fetch(url, { redirect: 'manual', headers: { accept: ACCEPT, ...headers } })
  return {
    status: response.status,
    header: (name) => response.headers.get(name),
    setCookies: () => response.headers.getSetCookie(),
    text: () => response.text(),
    cancel: async () => {
      await response.body?.cancel()
    },
  }
}

/**
 * 多站点检查的请求：主机名在 `hosts` 中的地址一律连接 `baseUrl`（preview）并以原主机作 Host 请求头，
 * 等价于 curl --resolve；不依赖 DNS（Node 不一定能解析 `*.localhost`）。其他地址照常请求。
 */
export function hostRequest(baseUrl, hosts) {
  const base = new URL(baseUrl)
  const client = base.protocol === 'https:' ? https : http
  return (url, headers = {}) => {
    const target = new URL(url)
    if (!hosts.has(target.hostname)) return fetchRequest(url, headers)
    return new Promise((resolveResponse, reject) => {
      const request = client.request(
        {
          hostname: base.hostname,
          port: base.port || undefined,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { ...headers, host: target.host, accept: ACCEPT },
          servername: target.hostname,
        },
        (response) => {
          resolveResponse({
            status: response.statusCode ?? 0,
            header: (name) => {
              const value = response.headers[name.toLowerCase()]
              return Array.isArray(value) ? value.join(', ') : (value ?? null)
            },
            setCookies: () => response.headers['set-cookie'] ?? [],
            text: () =>
              new Promise((done, fail) => {
                let body = ''
                response.setEncoding('utf8')
                response.on('data', (chunk) => {
                  body += chunk
                })
                response.on('end', () => done(body))
                response.on('error', fail)
              }),
            cancel: async () => {
              response.destroy()
            },
          })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }
}

/**
 * 抓取一个站内地址；3xx 跟随至多 5 次，记录最终状态、canonical 与 robots。
 * 重定向到本图站内主机（如 canonical 的正式域名）时改回 `origin` 请求，不访问线上站点。
 */
async function fetchPage({ origin, send, internalHosts }, path, parse) {
  let url = new URL(path, origin).href
  // 各跳响应的 Set-Cookie（公开页不得写语言 Cookie）
  const setCookies = []
  for (let hop = 0; hop < 6; hop += 1) {
    let response
    try {
      response = await send(url)
    } catch (error) {
      return { url, status: 599, error: String(error), setCookies }
    }
    setCookies.push(...response.setCookies())
    const location = response.header('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.cancel()
      const next = new URL(location, url)
      url = internalHosts.has(next.host)
        ? new URL(`${next.pathname}${next.search}`, origin).href
        : next.href
      continue
    }
    const html = (response.header('content-type') ?? '').includes('text/html')
    if (!html) {
      await response.cancel()
      return { url, status: response.status, setCookies }
    }
    const parsed = parsePage(await response.text())
    return {
      url,
      status: response.status,
      setCookies,
      canonical: parsed.canonical,
      robots: parsed.robots,
      parsed: parse ? parsed : undefined,
    }
  }
  return { url, status: 508, error: '重定向次数过多', setCookies }
}

async function pool(items, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await worker(items[index])
      }
    }),
  )
  return results
}

async function readSitemap(origin, send, path = '/sitemap.xml', seen = new Set()) {
  if (seen.has(path)) return []
  seen.add(path)
  const response = await send(new URL(path, origin).href)
  if (response.status < 200 || response.status >= 300) {
    await response.cancel()
    throw new Error(`站点地图 ${new URL(path, origin).href} 返回 ${response.status}`)
  }
  const xml = await response.text()
  const locations = sitemapLocations(xml)
  if (!/<sitemapindex\b/.test(xml)) return locations
  const nested = await Promise.all(
    locations.map((loc) => readSitemap(origin, send, new URL(loc).pathname, seen)),
  )
  return nested.flat()
}

/** 单次请求、不跟随重定向；正文只在 HTML 时读取 */
async function probe(send, url, headers = {}) {
  try {
    const response = await send(url, headers)
    const html = (response.header('content-type') ?? '').includes('text/html')
    const result = {
      url,
      status: response.status,
      location: response.header('location'),
      setCookies: response.setCookies(),
      body: html ? await response.text() : null,
    }
    if (!html) await response.cancel()
    return result
  } catch (error) {
    return { url, status: 599, location: null, setCookies: [], body: null, error: String(error) }
  }
}

/**
 * 需要额外请求的多语言规则（design.md 决策 7）：
 * - Accept-Language：各语言首页与抽样页分别以两种请求头请求，比较状态、Location、`<html lang>` 与规范化正文；
 * - 语言 Set-Cookie：已抓取的可索引页与上述请求的响应；
 * - 默认语言前缀：`/<默认语言>` 与 `/<默认语言>/pricing`（没有 pricing 时取一个可索引页）不跟随重定向，期望 301 到无前缀地址。
 */
async function checkLanguageRequests({
  origin,
  send,
  pages,
  indexable,
  homes,
  samples,
  cookies,
  defaultPrefix,
}) {
  const findings = []
  const cookieFindings = (path, setCookies) => {
    for (const name of languageCookies(setCookies, cookies))
      findings.push({
        rule: 'language-set-cookie',
        page: path,
        message: `公开页响应写入语言 Cookie「${name}」`,
      })
  }
  for (const page of pages) cookieFindings(page.path, page.setCookies ?? [])

  const paths = acceptLanguagePaths({ homes, indexable, samples })
  const compared = await pool(paths, (path) =>
    Promise.all(
      ACCEPT_LANGUAGE_VARIANTS.map(async (acceptLanguage) => ({
        acceptLanguage,
        ...(await probe(send, new URL(path, origin).href, { 'accept-language': acceptLanguage })),
      })),
    ),
  )
  paths.forEach((path, index) => {
    findings.push(...compareAcceptLanguage(path, compared[index]))
    for (const response of compared[index]) cookieFindings(path, response.setCookies)
  })

  if (defaultPrefix) {
    const inner = indexable.has('/pricing')
      ? '/pricing'
      : [...indexable].sort().find((path) => !homes.includes(path) && !path.includes('?'))
    const checks = [['/', defaultPrefix]]
    if (inner) checks.push([inner, `${defaultPrefix}${inner}`])
    const results = await pool(checks, ([, path]) => probe(send, new URL(path, origin).href))
    checks.forEach(([expected, path], index) => {
      const { url, status, location, setCookies } = results[index]
      const finding = checkDefaultPrefix({ path, expected, url, status, location })
      if (finding) findings.push(finding)
      cookieFindings(path, setCookies)
    })
  }
  return findings
}

/** 检查一张链接图（单站点为整个 preview，多站点为一个站点） */
async function checkGraph({ graph, send, config, locales, appUrl, language }) {
  const { origin, homes } = graph
  const locations = await readSitemap(origin, send)
  const internalHosts = new Set([new URL(origin).host])
  for (const loc of locations) internalHosts.add(new URL(loc).host)
  if (appUrl) internalHosts.add(new URL(appUrl).host)
  // 多站点：其他站点即使出现在本站站点地图中也不并入本图
  for (const host of graph.otherHosts) internalHosts.delete(host)
  const context = { origin, send, internalHosts }
  const indexable = new Set(
    locations.map((loc) => classifyHref(loc, origin, internalHosts)?.path).filter(Boolean),
  )
  const seeds = [...new Set([...indexable, ...homes])]
  const fetched = await pool(seeds, (path) => fetchPage(context, path, true))
  const pages = seeds.map((path, index) => ({ path, ...fetched[index] }))

  const targets = new Map(pages.map((page) => [page.path, page]))
  const pending = new Set()
  for (const page of pages)
    for (const { href } of [...(page.parsed?.links ?? []), ...(page.parsed?.alternates ?? [])]) {
      const target = classifyHref(href, page.url, internalHosts)
      if (target?.kind === 'internal' && !targets.has(target.path)) pending.add(target.path)
    }
  const extra = [...pending]
  const extraResults = await pool(extra, (path) => fetchPage(context, path, false))
  extra.forEach((path, index) => {
    targets.set(path, extraResults[index])
  })

  const result = analyzeLinkGraph({
    pages,
    targets,
    indexable,
    homes,
    internalHosts,
    locales,
    config,
  })
  const findings = await checkLanguageRequests({
    origin,
    send,
    pages,
    indexable,
    homes,
    ...language,
  })
  return addFindings(result, findings)
}

/**
 * 按 seo.linking 检查 `baseUrl` 上运行的站点。未声明 `seo.linking.sites[].previewHost` 时整个 preview 为一张图；
 * 声明后每个站点各自成图（docs/seo-internal-linking.md「多站点」），结果合并并保留各主机摘要，明细带主机名。
 */
export async function checkLinks({
  baseUrl,
  templateConfig,
  mode,
  localize,
  cookieName,
  acceptLanguageSamples = DEFAULT_ACCEPT_LANGUAGE_SAMPLES,
}) {
  const config = resolveLinkingConfig(templateConfig.seo?.linking)
  const effectiveMode = mode ?? config.mode
  const { i18n } = templateConfig
  const runtime = localize ? { localize, cookieName } : await loadRuntime(i18n)
  const graphs = planLinkGraphs({
    baseUrl,
    i18n,
    sites: config.sites,
    localize: runtime.localize,
  })
  const multilingual = i18n?.enabled !== false
  const language = {
    samples: acceptLanguageSamples,
    cookies: {
      names: [
        ...(runtime.cookieName ? [runtime.cookieName] : []),
        ...LEGACY_LANGUAGE_COOKIES,
        ...config.languageCookies,
      ],
      locales: multilingual ? (i18n?.locales ?? []) : [],
    },
  }
  const multi = graphs[0].host !== null
  const send = multi
    ? hostRequest(baseUrl, new Set(graphs.map((graph) => graph.host)))
    : fetchRequest
  const entries = []
  for (const graph of graphs) {
    const result = await checkGraph({
      graph,
      send,
      config,
      locales: graph.localePrefixes,
      language: {
        ...language,
        // 默认语言以无前缀地址服务的站点（单站点即整个 preview）检查 `/<默认语言>` 的 301
        defaultPrefix:
          multilingual && i18n && graph.homes.includes('/')
            ? `/${i18n.defaultLocale.toLowerCase()}`
            : null,
      },
      // 单站点沿用 app.url 作为站内主机；多站点各站点的正式域名以各自站点地图为准
      appUrl: multi ? undefined : templateConfig.app?.url,
    })
    entries.push({ host: graph.host, result })
  }
  return { result: mergeGraphResults(entries), mode: effectiveMode, config }
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      json: { type: 'string' },
      limit: { type: 'string' },
      'base-url': { type: 'string' },
      'accept-language-samples': { type: 'string' },
    },
  })
  const samples = values['accept-language-samples']
  if (samples !== undefined && !/^\d+$/.test(samples))
    throw new Error('--accept-language-samples 只接受非负整数')
  if (values.mode && values.mode !== 'report' && values.mode !== 'enforce')
    throw new Error('--mode 只接受 report 或 enforce')
  const started = performance.now()
  const templateConfig = await loadTemplateConfig()
  const preview = values['base-url'] ? null : await startPreview()
  const baseUrl = values['base-url'] ?? preview.baseUrl
  try {
    const { result, mode } = await checkLinks({
      baseUrl,
      templateConfig,
      mode: values.mode,
      acceptLanguageSamples: samples === undefined ? undefined : Number(samples),
    })
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.log(formatReport(result, { mode, limit: Number(values.limit ?? 20) }))
    console.log(`耗时 ${seconds} 秒（含 preview 启动）`)
    if (values.json) {
      mkdirSync(dirname(resolve(values.json)), { recursive: true })
      writeFileSync(
        resolve(values.json),
        `${JSON.stringify({ mode, seconds: Number(seconds), counts: countByRule(result), ...result }, null, 2)}\n`,
      )
    }
    const code = exitCode(result, mode)
    if (code !== 0)
      console.error(`链接图检查失败：${result.failures.length} 项失败级问题（mode=enforce）`)
    else if (result.failures.length > 0)
      console.log(`report 模式：${result.failures.length} 项失败级问题只报告，不影响退出码`)
    process.exitCode = code
  } finally {
    preview?.stop()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
