import type { Page } from '@playwright/test'
import {
  checkSecurityHeaders,
  collectViolations,
  type HeaderCheck,
  unconfirmed,
  type Violation,
} from './harden-support.ts'
import { evidence, expect, local, login, requireEnv, test } from './support.ts'

// harden-audit-findings 7.3「CSP 没有违规报告」与基础安全头（specs/web-security-headers）。
// 匿名用例只发 GET，可直接对 staging 运行；登录用例复用 support.ts 的普通用户 / 管理员登录。
test.describe.configure({ mode: 'serial' })

const https = () => new URL(process.env.STAGING_URL ?? 'http://missing').protocol === 'https:'

interface PageResult {
  page: string
  status: number | undefined
  headers: HeaderCheck
  violations: Violation[]
  consoleViolations: string[]
}

async function visit(page: Page, path: string, label: string): Promise<PageResult> {
  const collector = await collectViolations(page)
  const response = await page.goto(path)
  // dev 服务器与 Turnstile 可能持续有请求，networkidle 只作尽力等待。
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  // Turnstile iframe、懒加载组件在 networkidle 之后仍可能执行脚本；留出固定观察时间。
  await page.waitForTimeout(2_000)
  const { events, console } = await collector.read()
  const headers = checkSecurityHeaders(
    (await response?.allHeaders()) ?? {},
    https(),
    `${label} document`,
  )
  return {
    page: label,
    status: response?.status(),
    headers,
    violations: events,
    consoleViolations: console,
  }
}

function summarize(results: PageResult[]) {
  const violations = results.flatMap((result) =>
    result.violations.map((item) => ({ page: result.page, ...item })),
  )
  const consoleOnly = results.flatMap((result) =>
    result.consoleViolations.map((directive) => ({ page: result.page, directive })),
  )
  return { violations, consoleOnly, violationCount: violations.length + consoleOnly.length }
}

async function record(name: string, results: PageResult[]) {
  const summary = summarize(results)
  await evidence(name, {
    outcome: summary.violationCount === 0 ? 'passed' : 'failed',
    target: local ? 'local-dev' : 'staging',
    pages: results.map((result) => ({
      page: result.page,
      status: result.status,
      headers: result.headers,
      violationCount: result.violations.length + result.consoleViolations.length,
    })),
    ...summary,
  })
  // 有违规时把指令与被拦截来源（只有 origin / 关键字）写进失败信息，便于直接定位策略缺口。
  expect(
    summary.violationCount,
    `CSP violations: ${JSON.stringify([...summary.violations, ...summary.consoleOnly])}`,
  ).toBe(0)
}

test('CSP 匿名页面：首页、登录、注册、定价无 Report-Only 违规且带安全头', async ({ browser }) => {
  requireEnv(['STAGING_URL'])
  const results: PageResult[] = []
  for (const [path, label] of [
    ['/', 'home'],
    ['/login', 'login'],
    ['/register', 'register'],
    ['/pricing', 'pricing'],
  ] as const) {
    // 每页独立上下文：init script 与控制台监听不跨页累计。
    const context = await browser.newContext({ baseURL: process.env.STAGING_URL ?? '' })
    try {
      results.push(await visit(await context.newPage(), path, label))
    } finally {
      await context.close()
    }
  }
  for (const result of results) expect(result.status, `${result.page} status`).toBe(200)
  // 对照组：注入一个策略外图片来源，证明监听确实能收到 Report-Only 违规，0 次才有意义。
  // .invalid 域名不可解析，浏览器只做策略检查，不会向外部发出请求。
  const probeContext = await browser.newContext({ baseURL: process.env.STAGING_URL ?? '' })
  try {
    const probePage = await probeContext.newPage()
    const collector = await collectViolations(probePage)
    await probePage.goto('/')
    await probePage.evaluate(() => {
      const image = document.createElement('img')
      image.src = 'https://csp-probe.invalid/probe.png'
      document.body.append(image)
    })
    await expect
      .poll(async () => (await collector.read()).events.map((item) => item.directive))
      .toContain('img-src')
    const probe = await collector.read()
    expect(probe.events.find((item) => item.directive === 'img-src')?.disposition).toBe('report')
  } finally {
    await probeContext.close()
  }
  await record('harden-csp-anonymous', results)
})

test('安全头覆盖 API、重定向与 404；/assets/* 不经过 Worker 且缓存头合理', async ({ request }) => {
  requireEnv(['STAGING_URL'])
  const checks: Record<string, { status: number; headers: HeaderCheck }> = {}
  for (const [path, label] of [
    ['/api/health', 'api-health'],
    ['/app', 'redirect-app'],
    [`/harden-not-found-${Date.now()}`, 'not-found'],
  ] as const) {
    const response = await request.get(path, { maxRedirects: 0 })
    checks[label] = {
      status: response.status(),
      headers: checkSecurityHeaders(response.headers(), https(), label),
    }
  }
  expect(checks['api-health']?.status).toBe(200)
  expect(checks['redirect-app']?.status).toBeGreaterThanOrEqual(300)
  expect(checks['redirect-app']?.status).toBeLessThan(400)
  expect(checks['not-found']?.status).toBe(404)
  for (const check of Object.values(checks)) expect(check.headers.requestId).toBe(true)

  const html = await (await request.get('/')).text()
  const assets = [...new Set(html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) ?? [])].slice(
    0,
    3,
  )
  if (!assets.length) {
    await evidence('harden-csp-headers', { outcome: 'passed', checks, assets: [] })
    await unconfirmed(
      'harden-csp-assets',
      local ? '本地 vite dev 不产出 /assets/* 构建资源' : '首页未引用 /assets/* 资源',
    )
    return
  }
  const assetResults = []
  for (const path of assets) {
    const response = await request.get(path)
    const headers = response.headers()
    const cacheControl = headers['cache-control'] ?? ''
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] ?? -1)
    const immutable = /immutable/.test(cacheControl) && maxAge >= 31_536_000
    const revalidate = /no-cache|must-revalidate/.test(cacheControl) && Boolean(headers.etag)
    assetResults.push({
      kind: path.endsWith('.css') ? 'css' : 'js',
      status: response.status(),
      cacheControl,
      etag: Boolean(headers.etag),
      cacheStrategy: immutable ? 'immutable' : revalidate ? 'revalidate' : 'other',
      // Worker 入口统一附加请求 ID 与 CSP；静态资源由 Asset Worker 直接返回时两者都不存在。
      viaWorker: Boolean(headers['x-request-id'] || headers['content-security-policy-report-only']),
    })
  }
  await evidence('harden-csp-headers', { outcome: 'passed', checks, assets: assetResults })
  for (const asset of assetResults) {
    expect(asset.status).toBe(200)
    expect(asset.viaWorker, '/assets/* 应由 Asset Worker 直接返回').toBe(false)
    expect(asset.cacheStrategy, `/assets/* cache-control: ${asset.cacheControl}`).not.toBe('other')
  }
})

test('CSP 登录页面：对话、媒体、账单与后台首页无 Report-Only 违规', async ({ page, browser }) => {
  requireEnv(['STAGING_URL'])
  await login(page, 'user')
  const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
  expect(slug).not.toBe('')
  const results: PageResult[] = []
  for (const [path, label] of [
    [`/app/${slug}/chat`, 'chat'],
    [`/app/${slug}/media/new`, 'media'],
    [`/app/${slug}/billing`, 'billing'],
  ] as const) {
    // 复用已登录的上下文，但每页新开标签以重新注册监听。
    const tab = await page.context().newPage()
    try {
      results.push(await visit(tab, path, label))
    } finally {
      await tab.close()
    }
  }
  const adminContext = await browser.newContext({ baseURL: process.env.STAGING_URL ?? '' })
  try {
    const adminPage = await adminContext.newPage()
    await login(adminPage, 'admin')
    const tab = await adminContext.newPage()
    results.push(await visit(tab, '/admin', 'admin'))
    await expect(tab.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
  } finally {
    await adminContext.close()
  }
  for (const result of results) expect(result.status, `${result.page} status`).toBe(200)
  await record('harden-csp-authenticated', results)
})
