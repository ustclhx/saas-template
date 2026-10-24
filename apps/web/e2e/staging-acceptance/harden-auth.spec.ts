import { randomBytes, randomInt } from 'node:crypto'
import { type APIRequestContext, type Page, request as playwrightRequest } from '@playwright/test'
import { DUMMY_TURNSTILE_TOKEN, stubTurnstile } from '../turnstile.ts'
import { HUMAN_LOGIN_TIMEOUT } from './accounts.ts'
import {
  dedicatedEmail,
  nextRateLimitWindow,
  requireHeadedForStaging,
  sleep,
  turnstileTest as test,
} from './harden-support.ts'
import {
  ensureRegisteredAccount,
  evidence,
  expect,
  local,
  query,
  requireEnv,
  sqlLiteral,
} from './support.ts'

// harden-audit-findings 7.3「并发猜验证码被限流」（specs/user-auth「认证入口防刷」）。
// 限额取自 apps/web/wrangler.jsonc 的 RL_AUTH（各环境均为 simple limit 10 / period 60）与
// packages/auth/src/protection.ts：受保护与只限流路径先按 IP、再按邮箱摘要各消耗一次同一 RL_AUTH 额度；
// Better Auth emailOTP 未配置 allowedAttempts，默认 3 次错误后该验证码作废。
// staging 上限流按出口 IP 计：本文件会让当前出口 IP 的认证入口在每个阶段被封锁到当前 60 秒窗口结束，
// 结束前额外冷却一个窗口；请在其它验收之后单独、最后运行。
test.describe.configure({ mode: 'serial' })

const RL_AUTH_LIMIT = 10
const OTP_ALLOWED_ATTEMPTS = 3
const BURST = 15
const TOKEN_BURST = 12
// staging 的窗口边界未知，固定等待超过一个 period。
const STAGING_COOLDOWN = 65_000

const email = dedicatedEmail('harden-otp')
const password = `Harden-${randomBytes(12).toString('hex')}`
const origin = () => process.env.STAGING_URL ?? ''

type OtpKind = 'sign-in' | 'verify-email' | 'reset-password'
const KINDS: Record<
  OtpKind,
  { path: string; type: string; body: (otp: string) => Record<string, string> }
> = {
  'sign-in': { path: '/sign-in/email-otp', type: 'sign-in', body: (otp) => ({ email, otp }) },
  'verify-email': {
    path: '/email-otp/verify-email',
    type: 'email-verification',
    body: (otp) => ({ email, otp }),
  },
  'reset-password': {
    path: '/email-otp/reset-password',
    type: 'forget-password',
    body: (otp) => ({ email, otp, password: `Changed-${randomBytes(12).toString('hex')}` }),
  },
}

// 本地 workerd 信任 cf-connecting-ip；每个阶段换一组文档地址段 IP，互不占用额度。
let ipCounter = randomInt(1, 200)
const nextIp = () => `198.51.100.${(ipCounter++ % 254) + 1}`

interface Attempt {
  status: number
  code: string | null
}

async function post(
  context: APIRequestContext,
  path: string,
  data: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Attempt> {
  const response = await context.post(`/api/auth${path}`, {
    data,
    headers,
    failOnStatusCode: false,
  })
  let code: string | null = null
  try {
    code = ((await response.json()) as { code?: string } | null)?.code ?? null
  } catch {
    code = null
  }
  return { status: response.status(), code }
}

/** 只读取尝试次数与是否存在；验证码本身只在内存中用于最后一步，不写日志或证据。 */
async function verificationRow(type: string) {
  const rows = await query<{ value: string; expired: boolean }>(
    `select value, expires_at < now() as expired from verification
      where identifier = ${sqlLiteral(`${type}-otp-${email}`)} order by created_at desc`,
  )
  expect(rows.length, 'Each OTP identifier holds at most one row').toBeLessThanOrEqual(1)
  const row = rows[0]
  if (!row) return undefined
  const index = row.value.lastIndexOf(':')
  return {
    otp: row.value.slice(0, index),
    attempts: Number(row.value.slice(index + 1)),
    expired: row.expired,
  }
}

function wrongCode(otp: string, offset: number) {
  return String((Number(otp) + offset) % 1_000_000).padStart(6, '0')
}

function tally(attempts: Attempt[]) {
  const counts: Record<string, number> = {}
  for (const attempt of attempts) {
    const key = `${attempt.status}:${attempt.code ?? 'none'}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

async function cooldown() {
  if (local) await nextRateLimitWindow()
  else await sleep(STAGING_COOLDOWN)
}

async function preparePage(page: Page, ip: string) {
  if (local) {
    await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': ip })
    await stubTurnstile(page)
  }
}

/** 经登录页「邮箱验证码」表单发信（staging 由专用 Chrome 或人完成 Turnstile），必要时把请求类型改写为目标类型。 */
async function issueOtp(page: Page, type: string) {
  if (type !== 'sign-in')
    await page.route('**/api/auth/email-otp/send-verification-otp', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      await route.continue({ postData: JSON.stringify({ ...body, type }) })
    })
  try {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in with email code' }).click()
    const form = page.getByRole('form', { name: 'Sign in with email code' })
    await form.getByLabel('Email', { exact: true }).fill(email)
    const sent = page.waitForResponse('**/api/auth/email-otp/send-verification-otp', {
      timeout: local ? 30_000 : HUMAN_LOGIN_TIMEOUT,
    })
    await form
      .getByRole('button', { name: 'Send code' })
      .click({ timeout: local ? 30_000 : HUMAN_LOGIN_TIMEOUT })
    expect((await sent).status(), 'OTP send must be accepted').toBe(200)
    await expect(page.getByLabel('Verification code')).toBeVisible()
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
  const row = await verificationRow(type)
  expect(row, 'Issued OTP must be stored').toBeDefined()
  expect(row?.attempts).toBe(0)
  return row?.otp ?? ''
}

/** 登录接口在 staging 需要逐次 Turnstile，只能经 UI 提交；本地同样走 UI，保持一致。 */
async function submitSignInOtp(page: Page, code: string): Promise<Attempt> {
  const input = page.getByLabel('Verification code')
  await input.fill(code)
  const response = page.waitForResponse('**/api/auth/sign-in/email-otp', {
    timeout: local ? 30_000 : HUMAN_LOGIN_TIMEOUT,
  })
  await page
    .getByRole('button', { name: 'Sign in', exact: true })
    .click({ timeout: local ? 30_000 : HUMAN_LOGIN_TIMEOUT })
  const result = await response
  let parsed: string | null = null
  try {
    parsed = ((await result.json()) as { code?: string } | null)?.code ?? null
  } catch {
    parsed = null
  }
  return { status: result.status(), code: parsed }
}

async function burst(kind: OtpKind, otp: string) {
  const spec = KINDS[kind]
  // 本地模拟 3 个来源 IP 各 5 次（单 IP 不超额，只有邮箱维度生效）；staging 只能用当前出口 IP。
  const sources = local ? [nextIp(), nextIp(), nextIp()] : ['']
  const contexts = await Promise.all(
    sources.map((ip) =>
      playwrightRequest.newContext({
        baseURL: origin(),
        extraHTTPHeaders: {
          ...(local ? { 'cf-connecting-ip': ip } : {}),
          // 本地测试 secret 接受任意令牌，使登录请求越过 Turnstile 进入邮箱限流与验证码校验；
          // staging 没有可复用的令牌，登录请求应在 Turnstile 处被拒，不消耗验证码尝试。
          ...(local && kind === 'sign-in' ? { 'x-turnstile-token': DUMMY_TURNSTILE_TOKEN } : {}),
        },
      }),
    ),
  )
  try {
    return await Promise.all(
      Array.from({ length: BURST }, (_, index) =>
        post(
          contexts[index % contexts.length] as APIRequestContext,
          spec.path,
          spec.body(wrongCode(otp, index + 1)),
        ),
      ),
    )
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()))
  }
}

async function userState() {
  const [row] = await query<{ email_verified: boolean; password_digest: string | null }>(
    `select u.email_verified, md5(a.password) as password_digest from "user" u
      left join account a on a.user_id = u.id and a.provider_id = 'credential'
      where u.email = ${sqlLiteral(email)}`,
  )
  if (!row) throw new Error('Dedicated OTP user missing')
  return row
}

test('独立验证码校验接口已禁用：/api/auth/email-otp/check-verification-otp 返回 404', async () => {
  requireEnv(['STAGING_URL'])
  const context = await playwrightRequest.newContext({ baseURL: origin() })
  try {
    const result = await post(context, '/email-otp/check-verification-otp', {
      email,
      type: 'sign-in',
      otp: '000000',
    })
    await evidence('harden-auth-check-otp-disabled', { outcome: 'passed', status: result.status })
    expect(result.status).toBe(404)
  } finally {
    await context.dispose()
  }
})

test('准备专用一次性测试邮箱账号', async ({ page }) => {
  requireEnv(['STAGING_URL', 'NEON_READONLY_URL'])
  requireHeadedForStaging()
  const result = await ensureRegisteredAccount(
    page,
    async () =>
      (await query<{ id: string }>(`select id from "user" where email=${sqlLiteral(email)}`))[0],
    email,
    password,
    'Harden OTP acceptance',
  )
  const state = await userState()
  expect(state.email_verified, 'Dedicated account must start unverified').toBe(false)
  await evidence('harden-auth-dedicated-user', {
    outcome: 'passed',
    userId: result.account.id,
    registered: result.registered,
  })
})

for (const kind of ['sign-in', 'verify-email', 'reset-password'] as const) {
  test(`错误验证码并发：${kind} 超额返回 429，累计尝试 ≤ ${OTP_ALLOWED_ATTEMPTS}，锁定后正确验证码无效`, async ({
    page,
  }) => {
    requireEnv(['STAGING_URL', 'NEON_READONLY_URL'])
    requireHeadedForStaging()
    const spec = KINDS[kind]
    const before = await userState()
    // 新窗口开始后再发信与爆破，本地才能断言精确计数。
    await cooldown()
    const sendIp = nextIp()
    await preparePage(page, sendIp)
    const otp = await issueOtp(page, spec.type)

    const results = await burst(kind, otp)
    const limited = results.filter((result) => result.status === 429)
    const processed = results.filter((result) => result.status !== 429)
    const afterBurst = await verificationRow(spec.type)
    const burstAttempts = afterBurst ? afterBurst.attempts : OTP_ALLOWED_ATTEMPTS
    expect(
      results.filter((result) => result.status === 200),
      'No wrong code may succeed',
    ).toEqual([])
    expect(afterBurst?.attempts ?? 0).toBeLessThanOrEqual(OTP_ALLOWED_ATTEMPTS)
    if (local) {
      // 发信已占用该邮箱本窗口 1 次额度：精确剩 9 次进入校验，其余 6 次在邮箱维度返回 429。
      expect(processed).toHaveLength(RL_AUTH_LIMIT - 1)
      expect(limited).toHaveLength(BURST - (RL_AUTH_LIMIT - 1))
      for (const result of processed)
        expect(['400:INVALID_OTP', '403:TOO_MANY_ATTEMPTS']).toContain(
          `${result.status}:${result.code}`,
        )
      // 原子消费：最多一个请求读到已用尽的记录并删除它，其余竞争者读不到记录。
      expect(
        processed.filter((result) => result.code === 'TOO_MANY_ATTEMPTS').length,
      ).toBeLessThanOrEqual(1)
    } else {
      expect(limited.length, 'Burst beyond RL_AUTH must be rate limited').toBeGreaterThanOrEqual(1)
      // Cloudflare Rate Limiting 按数据中心最终一致；超出精确值时记为软失败供人工复核。
      expect.soft(processed.length).toBeLessThanOrEqual(RL_AUTH_LIMIT)
      if (kind === 'sign-in') {
        for (const result of processed) expect(result.code).toBe('TURNSTILE_FAILED')
        expect(afterBurst?.attempts, 'Turnstile 拒绝的请求不消耗验证码尝试').toBe(0)
      }
    }

    // 等到新窗口，逐次补足错误尝试直到锁定，再用正确验证码确认已失效。
    await cooldown()
    const sequential: Attempt[] = []
    const submit = (code: string) =>
      kind === 'sign-in'
        ? submitSignInOtp(page, code)
        : post(page.request, spec.path, spec.body(code))
    let counted = burstAttempts
    if (afterBurst) {
      for (; counted < OTP_ALLOWED_ATTEMPTS; counted++) {
        const result = await submit(wrongCode(otp, 100 + counted))
        sequential.push(result)
        expect(`${result.status}:${result.code}`).toBe('400:INVALID_OTP')
        expect((await verificationRow(spec.type))?.attempts).toBe(counted + 1)
      }
      const locked = await submit(wrongCode(otp, 200))
      sequential.push(locked)
      expect(`${locked.status}:${locked.code}`).toBe('403:TOO_MANY_ATTEMPTS')
    }
    expect(await verificationRow(spec.type), 'Exhausted OTP must be removed').toBeUndefined()
    const correct = await submit(otp)
    expect(`${correct.status}:${correct.code}`).toBe('400:INVALID_OTP')

    const after = await userState()
    const session = await (await page.request.get('/api/auth/get-session')).json()
    expect(session?.session ?? null, 'Locked sign-in OTP must not create a session').toBeNull()
    if (kind === 'verify-email') expect(after.email_verified).toBe(false)
    if (kind === 'reset-password') expect(after.password_digest).toBe(before.password_digest)

    await evidence(`harden-auth-otp-${kind}`, {
      outcome: 'passed',
      endpoint: spec.path,
      rateLimit: { limit: RL_AUTH_LIMIT, periodSeconds: 60 },
      allowedAttempts: OTP_ALLOWED_ATTEMPTS,
      burst: {
        requests: BURST,
        sourceIps: local ? 3 : 1,
        rateLimited: limited.length,
        processed: processed.length,
        responses: tally(results),
        attemptsAfterBurst: afterBurst?.attempts ?? null,
        lockedDuringBurst: !afterBurst,
      },
      sequential: { responses: tally(sequential), totalCountedAttempts: OTP_ALLOWED_ATTEMPTS },
      correctAfterLock: correct,
      sessionCreated: false,
      emailVerified: after.email_verified,
      passwordChanged: after.password_digest !== before.password_digest,
    })
  })
}

test('令牌重置密码并发：/reset-password 按 IP 超额返回 429', async () => {
  requireEnv(['STAGING_URL'])
  await cooldown()
  const context = await playwrightRequest.newContext({
    baseURL: origin(),
    extraHTTPHeaders: local ? { 'cf-connecting-ip': nextIp() } : {},
  })
  try {
    const results = await Promise.all(
      Array.from({ length: TOKEN_BURST }, () =>
        post(context, '/reset-password', {
          token: randomBytes(16).toString('hex'),
          newPassword: `Changed-${randomBytes(12).toString('hex')}`,
        }),
      ),
    )
    const limited = results.filter((result) => result.status === 429)
    const processed = results.filter((result) => result.status !== 429)
    expect(results.filter((result) => result.status === 200)).toEqual([])
    for (const result of processed)
      expect(`${result.status}:${result.code}`).toBe('400:INVALID_TOKEN')
    if (local) {
      // 请求体不含邮箱，只有 IP 维度：精确 10 次进入校验，2 次 429。
      expect(processed).toHaveLength(RL_AUTH_LIMIT)
      expect(limited).toHaveLength(TOKEN_BURST - RL_AUTH_LIMIT)
    } else {
      expect(limited.length).toBeGreaterThanOrEqual(1)
      expect.soft(processed.length).toBeLessThanOrEqual(RL_AUTH_LIMIT)
    }
    await evidence('harden-auth-reset-token', {
      outcome: 'passed',
      requests: TOKEN_BURST,
      rateLimited: limited.length,
      processed: processed.length,
      responses: tally(results),
    })
  } finally {
    await context.dispose()
  }
  // 留出一个窗口，避免同一出口 IP 紧接着运行的其它验收被 429。
  await cooldown()
})
