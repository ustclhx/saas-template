import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { evidence, expect, local, runId, test } from './support.ts'

// harden-audit-findings 7.3 验收（auth / CSP / 删号）共用的小工具；登录、只读查询与证据仍走 support.ts。

export type Outcome = 'passed' | 'unconfirmed'

/** 「无法确认」与失败分开：先留证再跳过，报告中显示为 skipped 并附原因。 */
export async function unconfirmed(
  name: string,
  reason: string,
  data: Record<string, unknown> = {},
) {
  await evidence(name, { outcome: 'unconfirmed' satisfies Outcome, reason, ...data })
  test.skip(true, `无法确认：${reason}`)
}

export function staging() {
  return !local
}

/** staging 上 Turnstile、管理员 Google 登录需要人在场；匿名只读用例不受此限。 */
export function requireHeadedForStaging() {
  if (!local && test.info().project.use.headless !== false)
    throw new Error('[验收准备] staging 写操作需要 headed 模式与人工 Turnstile，请加 --headed')
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface Violation {
  directive: string
  blocked: string
  disposition: string
  source: string
}

/** blockedURI 可能带路径或查询参数；只保留来源（origin 或 inline/eval/data 等关键字）。 */
export function safeSource(value: string) {
  if (!value) return 'none'
  if (/^[a-z-]+$/i.test(value)) return value
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol
  } catch {
    return 'unparsed'
  }
}

declare global {
  interface Window {
    __cspViolations?: Violation[]
  }
}

/** 在页面脚本执行前注册监听；Report-Only 违规不会阻断脚本，但会派发 securitypolicyviolation。 */
export async function collectViolations(page: Page) {
  const consoleViolations: string[] = []
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blocked: event.blockedURI,
        disposition: event.disposition,
        source: event.sourceFile,
      })
    })
  })
  page.on('console', (message) => {
    const text = message.text()
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) {
      // 控制台文本可能包含 URL；只保留指令名供诊断。
      const directive = text.match(/directive[^'"]*['"]([a-z-]+)/i)?.[1] ?? 'unknown'
      consoleViolations.push(directive)
    }
  })
  return {
    async read() {
      const events = (await page.evaluate(() => window.__cspViolations ?? []).catch(() => [])).map(
        (item) => ({
          directive: item.directive,
          blocked: safeSource(item.blocked),
          disposition: item.disposition,
          source: safeSource(item.source),
        }),
      )
      return { events, console: [...consoleViolations] }
    },
    reset() {
      consoleViolations.length = 0
    },
  }
}

export interface HeaderCheck {
  frame: string | null
  nosniff: string | null
  referrer: string | null
  hsts: string | null
  cspReportOnly: boolean
  cspEnforced: boolean
  frameAncestorsNone: boolean
  wildcardSource: boolean
  requestId: boolean
}

/** 规格 web-security-headers：所有响应带基础安全头；HTTPS 才发 HSTS；CSP 不通配全部来源。 */
export function checkSecurityHeaders(
  headers: Record<string, string>,
  https: boolean,
  label: string,
): HeaderCheck {
  const csp = headers['content-security-policy-report-only'] ?? ''
  const result: HeaderCheck = {
    frame: headers['x-frame-options'] ?? null,
    nosniff: headers['x-content-type-options'] ?? null,
    referrer: headers['referrer-policy'] ?? null,
    hsts: headers['strict-transport-security'] ?? null,
    cspReportOnly: csp !== '',
    cspEnforced: 'content-security-policy' in headers,
    frameAncestorsNone: /(?:^|;)\s*frame-ancestors 'none'\s*(?:;|$)/.test(csp),
    wildcardSource: csp.split(';').some((directive) => directive.trim().split(/\s+/).includes('*')),
    requestId: Boolean(headers['x-request-id']),
  }
  expect.soft(result.frame, `${label}: X-Frame-Options`).toBe('DENY')
  expect.soft(result.nosniff, `${label}: X-Content-Type-Options`).toBe('nosniff')
  expect.soft(result.referrer, `${label}: Referrer-Policy`).toBe('strict-origin-when-cross-origin')
  expect.soft(result.cspReportOnly, `${label}: CSP Report-Only`).toBe(true)
  expect.soft(result.cspEnforced, `${label}: CSP 仍处于 Report-Only 阶段`).toBe(false)
  expect.soft(result.frameAncestorsNone, `${label}: frame-ancestors 'none'`).toBe(true)
  expect.soft(result.wildcardSource, `${label}: CSP 不得通配全部来源`).toBe(false)
  if (https) {
    const maxAge = Number(result.hsts?.match(/max-age=(\d+)/)?.[1] ?? 0)
    expect.soft(maxAge, `${label}: HSTS max-age`).toBeGreaterThanOrEqual(31_536_000)
    expect
      .soft(result.hsts ?? '', `${label}: HSTS includeSubDomains`)
      .toContain('includeSubDomains')
  } else expect.soft(result.hsts, `${label}: HTTP 不发送 HSTS`).toBeNull()
  return result
}

/** 本地 Miniflare 的 RL_AUTH 按墙钟对齐 60 秒窗口；等到新窗口开始，便于断言精确次数。 */
export async function nextRateLimitWindow(marginMs = 1_000) {
  const period = 60_000
  await sleep(period - (Date.now() % period) + marginMs)
}

/**
 * support.ts 的 readEvidence 只读当天目录；删号后的 cron 检查可能隔天重跑，
 * 这里按同一证据根目录在所有日期目录中查找同一 runId 的记录，取最新一份。
 */
export async function readEvidenceAnyDate<T>(name: string): Promise<T | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid evidence name')
  const repository = fileURLToPath(new URL('../../../../', import.meta.url))
  const root = resolve(
    process.env.EVIDENCE_DIR || resolve(repository, 'test-results/evidence'),
    'staging-acceptance',
  )
  let dates: string[]
  try {
    dates = (await readdir(root)).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const date of dates.reverse()) {
    let payload: string
    try {
      payload = await readFile(resolve(root, date, `${runId}-${name}.json`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const saved = JSON.parse(payload)
    if (saved.runId !== runId || saved.target !== (local ? 'local-mocked' : 'staging-real'))
      throw new Error('Evidence identity mismatch')
    return saved.data as T
  }
}

/**
 * 会真实发信的专用账号邮箱：staging 用 Resend 官方测试地址（投递成功、不退信，保护发信域名信誉），
 * 本地仍用 @example.com（只写 dev 日志，不外发）。
 */
export function dedicatedEmail(label: string) {
  const tag = `${label}-${runId.toLowerCase()}`
  return local ? `${tag}@example.com` : `delivered+${tag}@resend.dev`
}
