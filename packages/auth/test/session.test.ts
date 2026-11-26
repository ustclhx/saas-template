import { env } from 'cloudflare:workers'
import { templateConfigDefaults } from '@saas/config'
import { createDb } from '@saas/db'
import { createCloudflareKv } from '@saas/platform/cloudflare'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE_CACHE_MAX_AGE } from '../src/index.ts'
import {
  cookieHeader,
  mockTurnstile,
  PASSWORD,
  setup,
  signUpBody,
  testUsers,
  withoutCookieCache,
} from './helpers.ts'

// 会话三层（tasks.md 2.2，design.md 决策 3）：Cookie 缓存 → KV（CACHE）→ 数据库。

const users = testUsers('session')

beforeAll(() => users.start())
beforeEach(() => {
  mockTurnstile()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
afterAll(() => users.cleanup())

async function signIn(s: ReturnType<typeof setup>, address: string) {
  const res = await s.post('/sign-in/email', { email: address, password: PASSWORD })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string; user: { id: string } }
  return { cookie: cookieHeader(res), token: body.token, userId: body.user.id }
}

async function sessionOf(s: ReturnType<typeof setup>, cookie: string) {
  const res = await s.get('/get-session', { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as { session: { token: string } } | null
}

describe('会话三层', () => {
  it('登录后会话同时写入 KV 与数据库，并下发 Cookie 缓存', async () => {
    const s = setup()
    const address = users.email('layers')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const { cookie, token } = await signIn(s, address)

    expect(cookie).toContain('session_data=')
    expect(await env.CACHE.get(`auth:${token}`)).toContain(token)
    const row = await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, token) })
    expect(row).toBeDefined()
  })

  it('KV 有会话时不查库：数据库不可达也能取到会话；KV 未命中时回退查库', async () => {
    const s = setup()
    const address = users.email('kv-hit')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const { cookie, token } = await signIn(s, address)
    // 去掉 Cookie 缓存，强制走到第二层
    const tokenOnly = withoutCookieCache(cookie)

    // 同一 secret 与 KV，但数据库连接一定失败：取到会话说明没有查库
    const noDb = setup({ db: createDb(env.HYPERDRIVE_REFUSED) })
    expect((await sessionOf(noDb, tokenOnly))?.session.token).toBe(token)

    // 对照：KV 中没有该会话时必须查库，数据库不可达就取不到
    const emptyKvNoDb = setup({
      db: createDb(env.HYPERDRIVE_REFUSED),
      cache: createCloudflareKv(env.CACHE_EMPTY),
    })
    // Better Auth 会把查库失败记为 error 日志：截获并确认确实尝试了查库
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const miss = await emptyKvNoDb.get('/get-session', { cookie: tokenOnly })
    expect(miss.status === 200 ? await miss.json() : null).toBeNull()
    expect(logged.mock.calls.flat().join(' ')).toContain('from "session"')
    logged.mockRestore()

    // KV 未命中、数据库可达：回退查库取到会话
    const emptyKv = setup({ cache: createCloudflareKv(env.CACHE_EMPTY) })
    expect((await sessionOf(emptyKv, tokenOnly))?.session.token).toBe(token)
  })

  it('Cookie 缓存有效期内不读 KV 也不查库', async () => {
    const s = setup()
    const address = users.email('cookie-cache')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const { cookie, token } = await signIn(s, address)
    const noStores = setup({
      db: createDb(env.HYPERDRIVE_REFUSED),
      cache: createCloudflareKv(env.CACHE_EMPTY),
    })
    expect((await sessionOf(noStores, cookie))?.session.token).toBe(token)
  })

  it('数据库中的会话被删除（吊销）后，旧 Cookie 在缓存过期后失效', async () => {
    const s = setup()
    const address = users.email('revoke')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const victim = await signIn(s, address)
    const other = await signIn(s, address)

    // 经 Better Auth 吊销：删除数据库行与 KV 副本
    const revoke = await s.post(
      '/revoke-session',
      { token: victim.token },
      { cookie: other.cookie },
    )
    expect(revoke.status).toBe(200)
    expect(
      await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, victim.token) }),
    ).toBeUndefined()
    expect(await env.CACHE.get(`auth:${victim.token}`)).toBeNull()

    // Cookie 缓存有效期内旧 Cookie 仍被接受（spec 允许的吊销延迟）
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    vi.setSystemTime(Date.now() + (SESSION_COOKIE_CACHE_MAX_AGE - 10) * 1000)
    expect((await sessionOf(s, victim.cookie))?.session.token).toBe(victim.token)

    // 缓存过期后回落到 KV / 数据库，会话已不存在
    vi.setSystemTime(Date.now() + 20 * 1000)
    expect(await sessionOf(s, victim.cookie)).toBeNull()
    // 未被吊销的会话不受影响
    expect((await sessionOf(s, other.cookie))?.session.token).toBe(other.token)
  })
})

describe('登录保持', () => {
  it('会话有效期取 auth.sessionDays，并记住上次登录方式（只存方式名）', async () => {
    const s = setup({ config: { auth: { ...templateConfigDefaults.auth, sessionDays: 45 } } })
    const address = users.email('remember')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const res = await s.post('/sign-in/email', { email: address, password: PASSWORD })
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }

    const row = await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, token) })
    const days = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(44.9)
    expect(days).toBeLessThanOrEqual(45)

    const method = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('better-auth.last_used_login_method='))
    expect(method).toMatch(/^better-auth\.last_used_login_method=email;/)
    expect(method).toContain(`Max-Age=${45 * 86_400}`)
    expect(method).not.toContain(address)
  })

  it('超过 updateAge 后 get-session（跳过 Cookie 缓存）把会话与 Cookie 有效期延长回 sessionDays', async () => {
    const s = setup()
    const address = users.email('renew')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const { cookie, token } = await signIn(s, address)
    const expiresAt = async () =>
      (await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, token) }))?.expiresAt
    const before = await expiresAt()

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    vi.setSystemTime(Date.now() + 2 * 86_400_000)
    const res = await s.get('/get-session?disableCookieCache=true', { cookie })
    expect(res.status).toBe(200)
    const after = await expiresAt()
    expect((after?.getTime() ?? 0) - (before?.getTime() ?? 0)).toBeGreaterThan(86_400_000)
    const renewed = res.headers.getSetCookie().find((c) => c.includes('session_token='))
    expect(renewed).toContain(`Max-Age=${30 * 86_400}`)
  })
})
