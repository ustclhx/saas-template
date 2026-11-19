// 构建后链接图检查（openspec seo-internal-linking design 决策 2，tasks 4.1–4.2）。
// 启动 `vite preview` 运行构建产物，以站点地图全部地址加各语言首页为种子按 HTTP 抓取，解析 `<a href>` 构建站内链接图，
// 规则见 check-links-graph.mjs。只读构建产物与模板配置，不依赖 publicPages() 的实现。
//
// 用法（先 `pnpm build`）：pnpm --filter @saas/web check:links [--mode report|enforce] [--json <文件>] [--limit <条数>]
//   --base-url <地址>：检查已在运行的服务，不启动 preview。
// report 只报告并以 0 退出；enforce 有失败项时以 1 退出。未传 --mode 时取 template config 的 seo.linking.mode。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  analyzeLinkGraph,
  classifyHref,
  countByRule,
  exitCode,
  formatReport,
  parsePage,
  resolveLinkingConfig,
  sitemapLocations,
} from './check-links-graph.mjs'

const WEB_ROOT = new URL('..', import.meta.url).pathname
const CONCURRENCY = 8
const START_TIMEOUT_MS = 60_000

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
    if (child.exitCode !== null)
      throw new Error(`vite preview 已退出（${child.exitCode}）：\n${log}`)
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

/** 抓取一个站内地址；3xx 跟随至多 5 次，记录最终状态、canonical 与 robots */
async function fetchPage(baseUrl, path, parse) {
  let url = new URL(path, baseUrl).href
  for (let hop = 0; hop < 6; hop += 1) {
    let response
    try {
      response = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html,*/*' } })
    } catch (error) {
      return { url, status: 599, error: String(error) }
    }
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel()
      url = new URL(location, url).href
      continue
    }
    const html = (response.headers.get('content-type') ?? '').includes('text/html')
    if (!html) {
      await response.body?.cancel()
      return { url, status: response.status }
    }
    const parsed = parsePage(await response.text())
    return {
      url,
      status: response.status,
      canonical: parsed.canonical,
      robots: parsed.robots,
      parsed: parse ? parsed : undefined,
    }
  }
  return { url, status: 508, error: '重定向次数过多' }
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

async function readSitemap(baseUrl, path = '/sitemap.xml', seen = new Set()) {
  if (seen.has(path)) return []
  seen.add(path)
  const response = await fetch(new URL(path, baseUrl))
  if (!response.ok) throw new Error(`站点地图 ${path} 返回 ${response.status}`)
  const xml = await response.text()
  const locations = sitemapLocations(xml)
  if (!/<sitemapindex\b/.test(xml)) return locations
  const nested = await Promise.all(
    locations.map((loc) => readSitemap(baseUrl, new URL(loc).pathname, seen)),
  )
  return nested.flat()
}

export async function checkLinks({ baseUrl, templateConfig, mode }) {
  const config = resolveLinkingConfig(templateConfig.seo?.linking)
  const effectiveMode = mode ?? config.mode
  const { i18n } = templateConfig
  const locales = i18n?.enabled === false ? [i18n.defaultLocale] : (i18n?.locales ?? [])
  const homes = locales.length
    ? locales.map((locale) => (locale === i18n.defaultLocale ? '/' : `/${locale}`))
    : ['/']
  const locations = await readSitemap(baseUrl)
  const internalHosts = new Set([new URL(baseUrl).host])
  for (const loc of locations) internalHosts.add(new URL(loc).host)
  if (templateConfig.app?.url) internalHosts.add(new URL(templateConfig.app.url).host)
  const indexable = new Set(
    locations.map((loc) => classifyHref(loc, baseUrl, internalHosts)?.path).filter(Boolean),
  )
  const seeds = [...new Set([...indexable, ...homes])]
  const fetched = await pool(seeds, (path) => fetchPage(baseUrl, path, true))
  const pages = seeds.map((path, index) => ({ path, ...fetched[index] }))

  const targets = new Map(pages.map((page) => [page.path, page]))
  const pending = new Set()
  for (const page of pages)
    for (const link of page.parsed?.links ?? []) {
      const target = classifyHref(link.href, page.url, internalHosts)
      if (target?.kind === 'internal' && !targets.has(target.path)) pending.add(target.path)
    }
  const extra = [...pending]
  const extraResults = await pool(extra, (path) => fetchPage(baseUrl, path, false))
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
  return { result, mode: effectiveMode, config }
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      json: { type: 'string' },
      limit: { type: 'string' },
      'base-url': { type: 'string' },
    },
  })
  if (values.mode && values.mode !== 'report' && values.mode !== 'enforce')
    throw new Error('--mode 只接受 report 或 enforce')
  const started = performance.now()
  const templateConfig = await loadTemplateConfig()
  const preview = values['base-url'] ? null : await startPreview()
  const baseUrl = values['base-url'] ?? preview.baseUrl
  try {
    const { result, mode } = await checkLinks({ baseUrl, templateConfig, mode: values.mode })
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
