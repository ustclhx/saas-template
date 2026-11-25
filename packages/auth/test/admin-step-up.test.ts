import { AppError, newId } from '@saas/shared'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type AdminStepUpDeps,
  createAdminStepUp,
  hotp,
  STEP_UP_FAILURE_LIMIT,
  totpStep,
} from '../src/admin-step-up.ts'
import type { AuthEmail } from '../src/index.ts'
import {
  cookieHeader,
  countingRateLimiter,
  PASSWORD,
  setup,
  signUpBody,
  testUsers,
} from './helpers.ts'

// add-admin-step-up tasks 2.1 / 2.3：重新验证服务的集成测试（真实 PG 与 Better Auth 2FA 插件）。

const users = testUsers('admin-step-up')
const s = setup({ config: { auth: { turnstile: false, twoFactor: true } }, rateLimiter: undefined })
const sql = s.db.$client
const sessions: string[] = []
const userIds: string[] = []

afterAll(async () => {
  if (sessions.length)
    await sql`delete from verification where identifier in ${sql(sessions.map((id) => `admin-step-up:${id}`))}`
  if (userIds.length) {
    await sql`delete from verification where identifier in ${sql(userIds.map((id) => `admin-step-up-lock:${id}`))}`
    await sql`delete from two_factor where user_id in ${sql(userIds)}`
  }
  await users.cleanup()
})

interface Account {
  readonly userId: string
  readonly email: string
  readonly cookie: string
  readonly session: { readonly id: string; readonly userId: string }
}

async function sessionByCookie(cookie: string) {
  const token = decodeURIComponent(cookie.split('session_token=')[1]?.split(';')[0] ?? '').split(
    '.',
  )[0]
  const row = await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, token ?? '') })
  if (!row) throw new Error('session missing')
  sessions.push(row.id)
  return { id: row.id, userId: row.userId }
}

/** 注册一个已验证邮箱、有密码的账号并返回其会话 */
async function account(name: string, { verified = true } = {}): Promise<Account> {
  const email = users.email(name)
  const res = await s.post('/sign-up/email', signUpBody(email))
  expect(res.status).toBe(200)
  const cookie = cookieHeader(res)
  const session = await sessionByCookie(cookie)
  userIds.push(session.userId)
  if (verified) await sql`update "user" set email_verified = true where id = ${session.userId}`
  return { userId: session.userId, email, cookie, session }
}

/** 同一账号的另一个会话（另一个浏览器） */
async function signIn(email: string) {
  const res = await s.post('/sign-in/email', { email, password: PASSWORD })
  expect(res.status).toBe(200)
  return sessionByCookie(cookieHeader(res))
}

const secretConfig = async () => (await s.auth.$context).secretConfig

/** 直接写入已完成绑定的 2FA（与插件同样的加密格式），返回 TOTP 密钥与备用码 */
async function enableTwoFactor(userId: string) {
  const key = await secretConfig()
  const secret = `secret-${newId()}`
  const backupCodes = ['aaaaa-11111', 'bbbbb-22222']
  await sql`insert into two_factor (id, secret, backup_codes, user_id, verified, created_at, updated_at)
    values (${newId()}, ${await symmetricEncrypt({ key, data: secret })},
      ${await symmetricEncrypt({ key, data: JSON.stringify(backupCodes) })}, ${userId}, true, now(), now())`
  await sql`update "user" set two_factor_enabled = true where id = ${userId}`
  return { secret, backupCodes }
}

async function service(overrides: Partial<AdminStepUpDeps> = {}) {
  const mail: Extract<AuthEmail, { type: 'admin-step-up-code' }>[] = []
  const deps: AdminStepUpDeps = {
    db: s.db,
    secretConfig: await secretConfig(),
    stepUpMinutes: 10,
    clientIp: '203.0.113.7',
    sendEmail: async (email) => {
      if (email.type === 'admin-step-up-code') mail.push(email)
    },
    ...overrides,
  }
  return { stepUp: createAdminStepUp(deps), mail, lastCode: () => mail.at(-1)?.otp ?? '' }
}

async function rejected(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection')
    },
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AppError)
  return error as AppError
}

const stepUpRow = (sessionId: string) =>
  s.db.query.adminStepUp.findFirst({ where: (t, { eq }) => eq(t.sessionId, sessionId) })
const audits = (userId: string, action: string) =>
  s.db.query.auditLog.findMany({
    where: (a, { and, eq }) => and(eq(a.actorUserId, userId), eq(a.action, action)),
  })
const sessionIds = async (userId: string) =>
  (await s.db.query.session.findMany({ where: (t, { eq }) => eq(t.userId, userId) }))
    .map((r) => r.id)
    .sort()

describe('admin step-up: email code and password', () => {
  it('verifies an email code within the current session without creating or replacing sessions', async () => {
    const a = await account('email')
    const before = await sessionIds(a.userId)
    const { stepUp, mail, lastCode } = await service()
    expect((await stepUp.options(a.session)).methods).toEqual(['email_otp', 'password'])
    const sent = await stepUp.sendCode(a.session)
    expect(mail).toEqual([
      {
        type: 'admin-step-up-code',
        to: a.email,
        otp: expect.stringMatching(/^\d{6}$/),
        expiresInMinutes: 10,
      },
    ])
    expect(sent.email).toMatch(/\*\*\*@/)
    // 只存哈希，不存明文验证码
    const [stored] =
      await sql`select value from verification where identifier = ${`admin-step-up:${a.session.id}`}`
    expect(stored?.value).not.toContain(lastCode())

    const verified = await stepUp.verify(a.session, { method: 'email_otp', code: lastCode() })
    expect(verified.method).toBe('email_otp')
    expect(await sessionIds(a.userId)).toEqual(before)
    const row = await stepUpRow(a.session.id)
    expect(row).toMatchObject({ userId: a.userId, method: 'email_otp' })
    expect((row?.expiresAt.getTime() ?? 0) - (row?.verifiedAt.getTime() ?? 0)).toBe(10 * 60_000)
    expect(await audits(a.userId, 'admin.step_up.verified')).toMatchObject([
      { targetId: a.userId, ip: '203.0.113.7', meta: { method: 'email_otp' } },
    ])
    // 验证码只能使用一次
    expect(
      (await rejected(stepUp.verify(a.session, { method: 'email_otp', code: lastCode() }))).code,
    ).toBe('STEP_UP_CODE_EXPIRED')
  })

  it('rejects a code requested by another session of the same account', async () => {
    const a = await account('cross')
    const other = await signIn(a.email)
    const { stepUp, lastCode } = await service()
    await stepUp.sendCode(a.session)
    expect(
      (await rejected(stepUp.verify(other, { method: 'email_otp', code: lastCode() }))).code,
    ).toBe('STEP_UP_CODE_EXPIRED')
    expect(await stepUpRow(other.id)).toBeUndefined()
    // 原会话仍可使用
    await stepUp.verify(a.session, { method: 'email_otp', code: lastCode() })
    // 另一会话（另一浏览器）仍未验证
    expect((await stepUp.status(other)).verified).toBeNull()
  })

  it('invalidates a code after three wrong attempts and enforces the resend cooldown', async () => {
    const a = await account('attempts')
    const start = Date.now()
    let clock = start
    const { stepUp, lastCode } = await service({ now: () => new Date(clock) })
    await stepUp.sendCode(a.session)
    const code = lastCode()
    const wrong = code === '000000' ? '111111' : '000000'
    const first = await rejected(stepUp.verify(a.session, { method: 'email_otp', code: wrong }))
    expect(first).toMatchObject({
      code: 'STEP_UP_INVALID',
      publicDetails: { attemptsRemaining: 2 },
    })
    expect((await rejected(stepUp.sendCode(a.session))).code).toBe('STEP_UP_RESEND_COOLDOWN')
    await rejected(stepUp.verify(a.session, { method: 'email_otp', code: wrong }))
    await rejected(stepUp.verify(a.session, { method: 'email_otp', code: wrong }))
    expect((await rejected(stepUp.verify(a.session, { method: 'email_otp', code }))).code).toBe(
      'STEP_UP_CODE_EXPIRED',
    )
    // 冷却结束后可重发，新码可用
    clock = start + 61_000
    await stepUp.sendCode(a.session)
    expect(lastCode()).not.toBe('')
    await stepUp.verify(a.session, { method: 'email_otp', code: lastCode() })
  })

  it('expires codes after 10 minutes and the verification after the configured minutes', async () => {
    const a = await account('expiry')
    const start = Date.now()
    let clock = start
    const { stepUp, lastCode } = await service({ now: () => new Date(clock), stepUpMinutes: 10 })
    await stepUp.sendCode(a.session)
    clock = start + 10 * 60_000 + 1000
    expect(
      (await rejected(stepUp.verify(a.session, { method: 'email_otp', code: lastCode() }))).code,
    ).toBe('STEP_UP_CODE_EXPIRED')
    await stepUp.verify(a.session, { method: 'password', password: PASSWORD })
    expect((await stepUp.status(a.session)).verified).toMatchObject({ method: 'password' })
    clock += 11 * 60_000
    expect((await stepUp.status(a.session)).verified).toBeNull()
  })

  it('locks the account after consecutive failures, audits it, and unlocks after 15 minutes', async () => {
    const a = await account('lock')
    const start = Date.now()
    let clock = start
    const { stepUp } = await service({ now: () => new Date(clock) })
    for (let i = 1; i < STEP_UP_FAILURE_LIMIT; i++)
      expect(
        (await rejected(stepUp.verify(a.session, { method: 'password', password: 'wrong' }))).code,
      ).toBe('STEP_UP_INVALID')
    const locked = await rejected(
      stepUp.verify(a.session, { method: 'password', password: 'wrong' }),
    )
    expect(locked.code).toBe('STEP_UP_LOCKED')
    expect(locked.publicDetails?.lockedUntil).toBe(new Date(start + 15 * 60_000).toISOString())
    expect(await audits(a.userId, 'admin.step_up.locked')).toHaveLength(1)
    // 锁定期间正确的密码与发送验证码同样被拒，其他会话也一样（按账号锁定）
    expect(
      (await rejected(stepUp.verify(a.session, { method: 'password', password: PASSWORD }))).code,
    ).toBe('STEP_UP_LOCKED')
    expect((await rejected(stepUp.sendCode(await signIn(a.email)))).code).toBe('STEP_UP_LOCKED')
    expect((await stepUp.status(a.session)).lockedUntil).toEqual(new Date(start + 15 * 60_000))
    clock = start + 15 * 60_000 + 1000
    await stepUp.verify(a.session, { method: 'password', password: PASSWORD })
    // 成功后失败计数清零
    expect((await stepUp.status(a.session)).lockedUntil).toBeNull()
  })

  it('rate limits by IP and account through RL_AUTH', async () => {
    const a = await account('ratelimit')
    const { stepUp } = await service({ rateLimiter: countingRateLimiter(1) })
    await stepUp.verify(a.session, { method: 'password', password: PASSWORD })
    expect(
      (await rejected(stepUp.verify(a.session, { method: 'password', password: PASSWORD }))).code,
    ).toBe('STEP_UP_RATE_LIMITED')
  })

  it('offers only a password to an account without a verified email', async () => {
    const a = await account('unverified', { verified: false })
    const { stepUp } = await service()
    expect((await stepUp.options(a.session)).methods).toEqual(['password'])
    expect((await rejected(stepUp.sendCode(a.session))).code).toBe('STEP_UP_METHOD_UNAVAILABLE')
  })
})

describe('admin step-up: two-factor accounts', () => {
  it('accepts TOTP and backup codes from a real Better Auth enrollment and rejects downgrades', async () => {
    const a = await account('enroll')
    // 经插件真实接口开启 2FA：密钥与备用码的存储格式由插件决定
    const enable = await s.post('/two-factor/enable', { password: PASSWORD }, { cookie: a.cookie })
    expect(enable.status).toBe(200)
    const { backupCodes } = (await enable.json()) as { backupCodes: string[] }
    const [row] = await sql`select secret from two_factor where user_id = ${a.userId}`
    const secret = await symmetricDecrypt({ key: await secretConfig(), data: String(row?.secret) })
    // 本模块的 HOTP 生成的验证码被插件接受：两边算法一致
    const finish = await s.post(
      '/two-factor/verify-totp',
      { code: await hotp(secret, totpStep(new Date())) },
      { cookie: a.cookie },
    )
    expect(finish.status).toBe(200)
    const session = await sessionByCookie(cookieHeader(finish))
    const { stepUp } = await service()
    expect((await stepUp.options(session)).methods).toEqual(['totp', 'backup_code'])

    // 不允许降级到密码或邮箱验证码
    const downgrade = await rejected(
      stepUp.verify(session, { method: 'password', password: PASSWORD }),
    )
    expect(downgrade).toMatchObject({
      code: 'STEP_UP_METHOD_UNAVAILABLE',
      publicDetails: { methods: ['totp', 'backup_code'] },
    })
    expect((await rejected(stepUp.sendCode(session))).code).toBe('STEP_UP_METHOD_UNAVAILABLE')

    const before = await sessionIds(a.userId)
    await stepUp.verify(session, { method: 'totp', code: await hotp(secret, totpStep(new Date())) })
    expect(await stepUpRow(session.id)).toMatchObject({ method: 'totp' })
    expect(await sessionIds(a.userId)).toEqual(before)

    const code = backupCodes[0] ?? ''
    await stepUp.verify(session, { method: 'backup_code', code })
    expect(await stepUpRow(session.id)).toMatchObject({ method: 'backup_code' })
    expect((await rejected(stepUp.verify(session, { method: 'backup_code', code }))).code).toBe(
      'STEP_UP_INVALID',
    )
    // 消耗后的备用码列表仍是插件可读的格式：插件本身也拒绝该码、接受另一个
    const [stored] = await sql`select backup_codes from two_factor where user_id = ${a.userId}`
    const remaining = JSON.parse(
      await symmetricDecrypt({ key: await secretConfig(), data: String(stored?.backup_codes) }),
    )
    expect(remaining).toEqual(backupCodes.slice(1))
  })

  it('accepts a TOTP code only once per time step across sessions', async () => {
    const a = await account('replay')
    // 开启 2FA 后密码登录需要第二因素，先建好另一个会话
    const other = await signIn(a.email)
    const { secret } = await enableTwoFactor(a.userId)
    const { stepUp } = await service()
    const now = new Date()
    const code = await hotp(secret, totpStep(now))
    await stepUp.verify(a.session, { method: 'totp', code })
    expect((await stepUpRow(a.session.id))?.lastTotpStep).toBe(totpStep(now))
    const replay = await rejected(stepUp.verify(a.session, { method: 'totp', code }))
    expect(replay).toMatchObject({ code: 'STEP_UP_INVALID', publicDetails: { reason: 'replayed' } })
    expect((await rejected(stepUp.verify(other, { method: 'totp', code }))).code).toBe(
      'STEP_UP_INVALID',
    )
    // 更早时间窗的验证码同样被拒；下一时间窗的验证码可用
    expect(
      (
        await rejected(
          stepUp.verify(other, { method: 'totp', code: await hotp(secret, totpStep(now) - 1) }),
        )
      ).code,
    ).toBe('STEP_UP_INVALID')
    await stepUp.verify(other, { method: 'totp', code: await hotp(secret, totpStep(now) + 1) })
  })
})

describe('admin step-up: rescue', () => {
  it('lets a listed two-factor admin verify by email code as rescue', async () => {
    const a = await account('rescue-listed')
    await enableTwoFactor(a.userId)
    const { stepUp, mail, lastCode } = await service({
      rescue: { enabled: true, bootstrapEmails: ` other@example.test, ${a.email.toUpperCase()} ` },
    })
    const options = await stepUp.options(a.session)
    expect(options).toMatchObject({ methods: ['totp', 'backup_code', 'rescue'], rescueMode: true })
    await stepUp.sendCode(a.session, 'rescue')
    expect(mail).toHaveLength(1)
    // 救援码不能当普通邮箱验证码用（2FA 账号没有 email_otp）
    expect(
      (await rejected(stepUp.verify(a.session, { method: 'email_otp', code: lastCode() }))).code,
    ).toBe('STEP_UP_METHOD_UNAVAILABLE')
    const verified = await stepUp.verify(a.session, { method: 'rescue', code: lastCode() })
    expect(verified.method).toBe('rescue')
    expect(await stepUpRow(a.session.id)).toMatchObject({ method: 'rescue' })
    expect(await audits(a.userId, 'admin.step_up.verified')).toMatchObject([
      { id: verified.auditId, meta: { method: 'rescue' } },
    ])
  })

  it('keeps regular methods for an admin outside the bootstrap list', async () => {
    const a = await account('rescue-unlisted')
    await enableTwoFactor(a.userId)
    const { stepUp } = await service({
      rescue: { enabled: true, bootstrapEmails: 'someone-else@example.test' },
    })
    expect(await stepUp.options(a.session)).toMatchObject({
      methods: ['totp', 'backup_code'],
      rescueMode: true,
    })
    expect((await rejected(stepUp.sendCode(a.session, 'rescue'))).code).toBe(
      'STEP_UP_METHOD_UNAVAILABLE',
    )
  })

  it('does not offer rescue while the switch is off', async () => {
    const a = await account('rescue-off')
    await enableTwoFactor(a.userId)
    const { stepUp } = await service({ rescue: { enabled: false, bootstrapEmails: a.email } })
    expect(await stepUp.options(a.session)).toMatchObject({
      methods: ['totp', 'backup_code'],
      rescueMode: false,
    })
    expect((await rejected(stepUp.sendCode(a.session, 'rescue'))).code).toBe(
      'STEP_UP_METHOD_UNAVAILABLE',
    )
  })
})
