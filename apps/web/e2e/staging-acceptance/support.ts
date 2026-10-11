import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import { stubTurnstile } from '../turnstile.ts'

export { expect, test }
export const runId = process.env.STAGING_ACCEPTANCE_RUN_ID ?? new Date().toISOString().slice(0, 10)
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) throw new Error('Invalid STAGING_ACCEPTANCE_RUN_ID')
export const local = process.env.STAGING_ACCEPTANCE_LOCAL === '1'
// 同一 worker 内复用新鲜会话，避免每个用例登录触发真实认证限流；Cookie 不落盘或输出。
const sessions = new Map<string, Parameters<BrowserContext['addCookies']>[0]>()
const evidenceDir = new URL(
  `../../../../docs/runbooks/evidence/staging-acceptance/${new Date().toISOString().slice(0, 10)}/`,
  import.meta.url,
)

export async function readEvidence<T>(name: string): Promise<T | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid evidence name')
  let payload: string
  try {
    payload = await readFile(new URL(`${runId}-${name}.json`, evidenceDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const saved = JSON.parse(payload)
  if (saved.runId !== runId || saved.target !== (local ? 'local-mocked' : 'staging-real'))
    throw new Error('Evidence identity mismatch')
  return saved.data as T
}

export function requireEnv(names: string[]) {
  const missing = names.filter((name) => !process.env[name])
  test.skip(missing.length > 0, `Missing environment variables: ${missing.join(', ')}`)
}

export function sqlLiteral(value: string) {
  if (value.includes('\0')) throw new Error('Invalid SQL literal')
  return `'${value.replaceAll("'", "''")}'`
}

export async function query<T extends Record<string, unknown>>(statement: string): Promise<T[]> {
  requireEnv(['NEON_READONLY_URL'])
  // 连接串仅通过继承环境传递；SQL 走 stdin，错误不透传 psql 的连接诊断或数据。
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'U',
        'saas-template-pg',
        'sh',
        '-c',
        'exec psql "$U" -X -q -t -A -v ON_ERROR_STOP=1',
      ],
      {
        env: { ...process.env, U: process.env.NEON_READONLY_URL },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.resume()
    child.on('error', () => reject(new Error('Read-only evidence query could not start')))
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error('Read-only evidence query failed')),
    )
    child.stdin.end(
      `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout = '30s';\nSELECT coalesce(json_agg(evidence_row), '[]'::json) FROM (${statement}) AS evidence_row;\nROLLBACK;\n`,
    )
  })
  try {
    return JSON.parse(result.trim()) as T[]
  } catch {
    throw new Error('Invalid read-only evidence result')
  }
}

export async function login(page: Page, account: 'admin' | 'user') {
  const prefix = account === 'admin' ? 'STAGING_ADMIN' : 'STAGING_USER'
  requireEnv(['STAGING_URL', `${prefix}_EMAIL`, `${prefix}_PASSWORD`])
  if (local) {
    await page.context().setExtraHTTPHeaders({
      'cf-connecting-ip': `192.0.2.${1 + Math.floor(Math.random() * 254)}`,
    })
    await stubTurnstile(page)
  }
  const cached = sessions.get(prefix)
  if (cached) {
    await page.context().addCookies(cached)
    await page.goto('/app')
    if (/\/app\/[^/?#]+\/?$/.test(new URL(page.url()).pathname)) return
    sessions.delete(prefix)
    await page.context().clearCookies()
  }
  await page.goto('/login')
  const form = page.getByRole('form', { name: 'Sign in with password' })
  await form.getByLabel('Email', { exact: true }).fill(process.env[`${prefix}_EMAIL`] ?? '')
  await form.getByLabel('Password', { exact: true }).fill(process.env[`${prefix}_PASSWORD`] ?? '')
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/[^/?#]+\/?$/)
  sessions.set(prefix, await page.context().cookies())
}

export async function registerAccount(page: Page, email: string, password: string, name: string) {
  if (local) {
    await page
      .context()
      .setExtraHTTPHeaders({ 'cf-connecting-ip': `192.0.2.${1 + Math.floor(Math.random() * 254)}` })
    await stubTurnstile(page)
  }
  await page.goto('/register')
  const form = page.getByRole('form', { name: 'Create an account' })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Email', { exact: true }).fill(email)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/[^/?#]+\/?$/)
}

export async function evidence(name: string, data: unknown) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid evidence name')
  const payload = JSON.stringify(
    {
      runId,
      target: local ? 'local-mocked' : 'staging-real',
      recordedAt: new Date().toISOString(),
      data,
    },
    null,
    2,
  )
  // 防止误把凭据、邮箱或带签名的下载地址写进可提交证据。
  const secrets = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        value && /(?:PASSWORD|COOKIE|SECRET|TOKEN|KEY|DATABASE_URL|READONLY_URL)$/.test(key),
    )
    .map(([, value]) => value as string)
  if (
    secrets.some((value) => value.length > 3 && payload.includes(value)) ||
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(payload) ||
    /"(?:password|cookie|authorization|email|prompt|parts|downloadUrl)"\s*:/i.test(payload)
  )
    throw new Error('Evidence contains a forbidden sensitive value or field')
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(new URL(`${runId}-${name}.json`, evidenceDir), `${payload}\n`)
}

export async function reconcile(workspaceId: string) {
  const id = sqlLiteral(workspaceId)
  const [snapshot] = await query<{
    ledgerTotal: number
    activeRemaining: number
    held: number
    debt: number
  }>(`SELECT
    (SELECT coalesce(sum(delta),0) FROM credit_ledger WHERE workspace_id=${id}) AS "ledgerTotal",
    (SELECT coalesce(sum(remaining),0) FROM credit_grant WHERE workspace_id=${id} AND status='active') AS "activeRemaining",
    (SELECT coalesce(sum(amount),0) FROM credit_hold WHERE workspace_id=${id} AND status='held') AS held,
    (SELECT coalesce(sum(amount),0) FROM credit_debt WHERE workspace_id=${id}) AS debt`)
  if (!snapshot) throw new Error('Missing credit snapshot')
  const expectedTotal = snapshot.activeRemaining + snapshot.held - snapshot.debt
  const difference = snapshot.ledgerTotal - expectedTotal
  expect(difference, 'Credit reconciliation invariant').toBe(0)
  return { ...snapshot, expectedTotal, difference, consistent: difference === 0 }
}
