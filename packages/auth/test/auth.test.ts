import { env } from 'cloudflare:workers'
import { defineTemplateConfig, type TemplateConfigInput } from '@saas/config'
import { createDb } from '@saas/db'
import { isUuidV7, newId } from '@saas/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AuthEmail, createAuth } from '../src/index.ts'

// createAuth 的登录方式开关（tasks.md 2.1，specs/user-auth「可配置的登录方式」）：
// 在 workerd 中经 Hyperdrive 连接本地 PG；OAuth 凭据为假值，邮件发送为记录调用的假实现，
// 不访问任何外部服务（OAuth 登录只生成授权 URL，不请求提供方）。

const APP_URL = 'http://localhost:3000'
const testEnv = {
  BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  APP_URL,
  GOOGLE_CLIENT_ID: 'fake-google-id',
  GOOGLE_CLIENT_SECRET: 'fake-google-secret',
  GITHUB_CLIENT_ID: 'fake-github-id',
  GITHUB_CLIENT_SECRET: 'fake-github-secret',
}
const app = { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' }
// 本文件创建的用户都用这个后缀，结束时统一清理
const EMAIL_DOMAIN = `${newId()}.auth-test.example`
const email = (name: string) => `${name}-${newId()}@${EMAIL_DOMAIN}`
const createdOrgs: string[] = []
// verification 行（OTP、魔法链接、OAuth state、重置密码）不一定带邮箱，按创建时间清理
// （在 beforeAll 中取值：workerd 在模块顶层不推进时钟）
let startedAt = new Date()

function setup(overrides: Omit<TemplateConfigInput, 'app'> = {}) {
  const sent: AuthEmail[] = []
  const auth = createAuth(testEnv, createDb(env.HYPERDRIVE), {
    config: defineTemplateConfig({ app, ...overrides }),
    sendEmail: async (message) => {
      sent.push(message)
    },
  })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${APP_URL}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_URL, ...headers },
        body: JSON.stringify(body),
      }),
    )
  return { auth, sent, post }
}

const signUpBody = (address: string) => ({
  email: address,
  password: 'correct-horse-battery-staple',
  name: 'Test User',
})

beforeAll(() => {
  startedAt = new Date()
})

// 清理用原始 SQL：本包不直接依赖 drizzle-orm（better-auth 会引入另一个带 kysely 的 drizzle-orm 变体，
// 两者的 SQL 类型不兼容），查询断言用 @saas/db 实例自带的 relational query API。
afterAll(async () => {
  const sql = createDb(env.HYPERDRIVE).$client
  const users = await sql<
    { id: string }[]
  >`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  const ids = users.map((u) => u.id)
  await sql`delete from verification where created_at >= ${startedAt.toISOString()}`
  if (ids.length === 0) return
  await sql`delete from session where user_id in ${sql(ids)}`
  if (createdOrgs.length > 0) {
    await sql`delete from member where organization_id in ${sql(createdOrgs)}`
    await sql`delete from organization where id in ${sql(createdOrgs)}`
  }
  await sql`delete from account where user_id in ${sql(ids)}`
  await sql`delete from "user" where id in ${sql(ids)}`
})

describe('邮箱密码', () => {
  it('开启时可注册，user id 为 generateId 生成的 UUIDv7，并发送验证邮件', async () => {
    const { post, sent } = setup()
    const address = email('signup')
    const res = await post('/sign-up/email', signUpBody(address))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { id: string; email: string } }
    expect(isUuidV7(body.user.id)).toBe(true)

    const db = createDb(env.HYPERDRIVE)
    const row = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, body.user.id) })
    expect(row).toMatchObject({ email: address, emailVerified: false, role: 'user' })
    const acc = await db.query.account.findFirst({
      where: (a, { eq }) => eq(a.userId, body.user.id),
    })
    expect(isUuidV7(acc?.id ?? '')).toBe(true)
    expect(acc?.providerId).toBe('credential')

    expect(sent).toEqual([{ type: 'verify-email', to: address, url: expect.any(String) }])
  })

  it('开启时可用密码登录，会话 id 为 UUIDv7', async () => {
    const { post } = setup()
    const address = email('signin')
    expect((await post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const res = await post('/sign-in/email', {
      email: address,
      password: signUpBody(address).password,
    })
    expect(res.status).toBe(200)
    const { user: signedIn } = (await res.json()) as { user: { id: string } }
    const db = createDb(env.HYPERDRIVE)
    const sessions = await db.query.session.findMany({
      where: (t, { eq }) => eq(t.userId, signedIn.id),
    })
    expect(sessions.length).toBeGreaterThan(0)
    for (const s of sessions) expect(isUuidV7(s.id)).toBe(true)
  })

  it('开启时找回密码发送重置邮件', async () => {
    const { post, sent } = setup()
    const address = email('reset')
    expect((await post('/sign-up/email', signUpBody(address))).status).toBe(200)
    expect((await post('/request-password-reset', { email: address })).status).toBe(200)
    expect(sent.map((m) => m.type)).toEqual(['verify-email', 'reset-password'])
  })

  it('关闭时注册、登录、找回密码接口都返回错误，不创建用户也不发邮件', async () => {
    // 先在开启时注册一个已有账号，确认关闭后找回密码也不会给已有账号发邮件
    const existing = email('existing')
    expect((await setup().post('/sign-up/email', signUpBody(existing))).status).toBe(200)

    const { post, sent } = setup({ auth: { emailPassword: false } })
    expect((await post('/request-password-reset', { email: existing })).status).toBe(400)
    const address = email('disabled')
    const signUp = await post('/sign-up/email', signUpBody(address))
    expect(signUp.status).toBeGreaterThanOrEqual(400)
    const signIn = await post('/sign-in/email', {
      email: address,
      password: signUpBody(address).password,
    })
    expect(signIn.status).toBeGreaterThanOrEqual(400)
    const reset = await post('/request-password-reset', { email: address })
    expect(reset.status).toBeGreaterThanOrEqual(400)

    const db = createDb(env.HYPERDRIVE)
    expect(await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, address) })).toBe(
      undefined,
    )
    expect(sent).toEqual([])
  })
})

describe('魔法链接', () => {
  it('关闭时（默认）发送接口返回错误且不发邮件', async () => {
    const { post, sent } = setup()
    const res = await post('/sign-in/magic-link', { email: email('ml-off') })
    expect(res.status).toBe(404)
    expect(sent).toEqual([])
  })

  it('开启时发送魔法链接邮件', async () => {
    const { post, sent } = setup({ auth: { magicLink: true } })
    const address = email('ml-on')
    const res = await post('/sign-in/magic-link', { email: address })
    expect(res.status).toBe(200)
    expect(sent).toEqual([{ type: 'magic-link', to: address, url: expect.any(String) }])
  })
})

describe('邮箱验证码', () => {
  it('关闭时发送接口返回错误且不发邮件', async () => {
    const { post, sent } = setup({ auth: { emailOtp: false } })
    const res = await post('/email-otp/send-verification-otp', {
      email: email('otp-off'),
      type: 'sign-in',
    })
    expect(res.status).toBe(404)
    expect(sent).toEqual([])
  })

  it('开启时（默认）发送验证码邮件', async () => {
    const { post, sent } = setup()
    const address = email('otp-on')
    const res = await post('/email-otp/send-verification-otp', { email: address, type: 'sign-in' })
    expect(res.status).toBe(200)
    expect(sent).toEqual([
      { type: 'otp', to: address, otp: expect.stringMatching(/^\d{6}$/), purpose: 'sign-in' },
    ])
  })

  it('与魔法链接同时开启时两者都可用', async () => {
    const { post, sent } = setup({ auth: { emailOtp: true, magicLink: true } })
    const address = email('both')
    expect(
      (await post('/email-otp/send-verification-otp', { email: address, type: 'sign-in' })).status,
    ).toBe(200)
    expect((await post('/sign-in/magic-link', { email: address })).status).toBe(200)
    expect(sent.map((m) => m.type)).toEqual(['otp', 'magic-link'])
  })
})

describe('OAuth', () => {
  it('只启用配置中的提供方：启用的返回授权 URL，未启用的返回错误', async () => {
    const { post } = setup({ auth: { oauth: ['google'] } })
    const google = await post('/sign-in/social', { provider: 'google', disableRedirect: true })
    expect(google.status).toBe(200)
    const { url } = (await google.json()) as { url: string }
    expect(new URL(url).hostname).toBe('accounts.google.com')
    expect(new URL(url).searchParams.get('client_id')).toBe('fake-google-id')

    const github = await post('/sign-in/social', { provider: 'github', disableRedirect: true })
    expect(github.status).toBeGreaterThanOrEqual(400)
  })

  it('全部关闭时任何提供方都返回错误', async () => {
    const { post } = setup({ auth: { oauth: [] } })
    for (const provider of ['google', 'github']) {
      const res = await post('/sign-in/social', { provider, disableRedirect: true })
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
  })

  it('启用的提供方缺少凭据时 createAuth 直接报错（只列变量名）', () => {
    expect(() =>
      createAuth({ ...testEnv, GITHUB_CLIENT_SECRET: undefined }, createDb(env.HYPERDRIVE), {
        config: defineTemplateConfig({ app, auth: { oauth: ['github'] } }),
        sendEmail: async () => {},
      }),
    ).toThrow('Invalid environment: missing GITHUB_CLIENT_SECRET')
  })
})

describe('两步验证', () => {
  it('关闭时（默认）接口不存在', async () => {
    const { post } = setup()
    expect((await post('/two-factor/enable', { password: 'x' })).status).toBe(404)
  })

  it('开启时接口存在（未登录返回 401）', async () => {
    const { post } = setup({ auth: { twoFactor: true } })
    expect((await post('/two-factor/enable', { password: 'x' })).status).toBe(401)
  })
})

describe('其他插件开关', () => {
  it('publicApi 关闭时（默认）API Key 接口不存在', async () => {
    const { post } = setup()
    expect((await post('/api-key/create', { name: 'k' })).status).toBe(404)
  })

  it('multiTenant=false 时用户不能自行创建空间', async () => {
    const { post } = setup()
    const signUp = await post('/sign-up/email', signUpBody(email('org')))
    const cookie = signUp.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).not.toBe('')
    const res = await post(
      '/organization/create',
      { name: 'Team', slug: `t-${newId()}` },
      { cookie },
    )
    expect(res.status).toBe(403)
  })

  it('organization 插件在 uuid 列上可用：multiTenant=true 时创建空间与 owner 成员', async () => {
    const { post } = setup({ tenancy: { multiTenant: true } })
    const signUp = await post('/sign-up/email', signUpBody(email('team')))
    const cookie = signUp.headers.get('set-cookie')?.split(';')[0] ?? ''
    const res = await post(
      '/organization/create',
      { name: 'Team', slug: `t-${newId()}` },
      { cookie },
    )
    expect(res.status).toBe(200)
    const org = (await res.json()) as { id: string }
    expect(isUuidV7(org.id)).toBe(true)

    const db = createDb(env.HYPERDRIVE)
    const row = await db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, org.id) })
    expect(row).toMatchObject({ isPersonal: false, deletedAt: null })
    const members = await db.query.member.findMany({
      where: (m, { eq }) => eq(m.organizationId, org.id),
    })
    expect(members).toHaveLength(1)
    expect(members[0]?.role).toBe('owner')
    expect(isUuidV7(members[0]?.id ?? '')).toBe(true)
    createdOrgs.push(org.id)
  })
})
