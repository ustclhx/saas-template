import { createAuth, parseAuthEnv } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import type { KeyValueStore } from '@saas/platform'
import { AppError, newId } from '@saas/shared'
import { symmetricEncrypt } from 'better-auth/crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminCache, createAdminTestDb } from './admin-test-resources.ts'

// add-admin-step-up tasks 2.2 / 2.3：重新验证 Server Functions（状态、发码、校验）、
// STEP_UP_REQUIRED 携带可用方式，以及救援验证的运营通知。只替换 Server Function 传输与请求环境。

const runtimeRef = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('@tanstack/react-start', () => ({
  createMiddleware: () => ({ server: () => ({}) }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    }
    return builder
  },
}))
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => ({ headers: new Headers() }),
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}))
vi.mock('../src/features/admin/admin.functions.ts', () => ({ adminMiddleware: {} }))
vi.mock('../src/server/runtime.ts', () => ({ getWebRuntime: () => runtimeRef.current }))

import { type AdminActionContext, runAdminAction } from '../src/features/admin/action.ts'
import { overrideStepUpEnforcedForTesting } from '../src/features/admin/step-up/check.ts'
import {
  getStepUpStatus,
  sendStepUpCode,
  verifyStepUp,
} from '../src/features/admin/step-up/step-up.functions.ts'
import { createWebAuth } from '../src/server/auth.ts'
import type { WebRuntime } from '../src/server/runtime.ts'
import { templateConfig } from '../src/server/template-config.ts'

const APP_URL = 'http://localhost:3000'
const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const PASSWORD = 'correct-horse-battery'
const domain = `${newId()}.step-up-verify.example`
const db = createAdminTestDb()
const migrator = createAdminTestDb('migrator')
const baseConfig = {
  APP_URL,
  BETTER_AUTH_SECRET: SECRET,
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  GOOGLE_CLIENT_ID: 'test',
  GOOGLE_CLIENT_SECRET: 'test',
  GITHUB_CLIENT_ID: 'test',
  GITHUB_CLIENT_SECRET: 'test',
}
const auth = createAuth({ APP_URL, BETTER_AUTH_SECRET: SECRET }, db, {
  config: defineTemplateConfig({
    app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.com' },
    auth: { oauth: [], turnstile: false },
  }),
  sendEmail: async () => {},
})

// web 测试 Worker 没有 RL_AUTH 绑定；限流语义由 @saas/auth 的集成测试覆盖
const rateLimiter = { limit: async () => ({ success: true }) }

const emails: { template: string; to: string; props: { otp?: string } }[] = []
const events: { operations: { event: string; sourceId: string }[] }[] = []

function createRuntime(env: Record<string, string> = {}): WebRuntime {
  const requestMeta = { clientIp: '203.0.113.31', requestId: newId() }
  const create = (database: typeof db, cache: KeyValueStore = adminCache) =>
    createWebAuth({ ...baseConfig, ...env }, database, {
      cache,
      rateLimiter,
      clientIp: requestMeta.clientIp,
      sendEmail: async () => {},
    })
  const capture = <T>(list: T[]) => ({
    available: true as const,
    value: { send: async (message: T) => void list.push(message) },
  })
  return {
    config: { ...parseAuthEnv({ ...baseConfig, ...env }, templateConfig), PAYMENT_MODE: 'test' },
    db,
    publicDb: db,
    cache: adminCache,
    rateLimiter,
    requestMeta,
    emailQueue: capture(emails),
    eventsQueue: capture(events),
    auth: create(db),
    createAuth: create,
  } as unknown as WebRuntime
}

async function signUpAdmin() {
  const email = `${newId()}@${domain}`
  const response = await auth.handler(
    new Request(`${APP_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Step-up verify' }),
    }),
  )
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  await db.$client`update "user" set role='admin', email_verified=true where id=${user.id}`
  const [row] = await db.$client<{ id: string }[]>`select id from session where user_id=${user.id}`
  const context: AdminActionContext = {
    db,
    admin: { id: user.id },
    ip: '203.0.113.31',
    session: { id: row?.id as string, userId: user.id },
  }
  return { id: user.id, email, context }
}

type Fn = (input: { context: AdminActionContext; data?: unknown }) => Promise<unknown>
const call = <T>(fn: unknown, context: AdminActionContext, data?: unknown) =>
  (fn as Fn)({ context, data }) as Promise<T>

interface Status {
  enforced: boolean
  verified: { method: string; expiresAt: string } | null
  methods: string[]
  rescueMode: boolean
  lockedUntil: string | null
  email: string | null
  code: { expiresAt: string; resendAt: string } | null
}
type Result =
  | { ok: true; method: string; expiresAt: string }
  | { ok: false; error: string; details?: Record<string, unknown> }

const lastCode = (to: string) =>
  emails.filter((m) => m.to === to && m.template === 'admin-step-up-code').at(-1)?.props.otp ?? ''

beforeAll(() => {
  runtimeRef.current = createRuntime()
})

afterAll(async () => {
  overrideStepUpEnforcedForTesting(undefined)
  const users = await db.$client<
    { id: string }[]
  >`select id from "user" where email like ${`%@${domain}`}`
  const ids = users.map((u) => u.id)
  if (!ids.length) return
  const sessions = await db.$client<
    { id: string }[]
  >`select id from session where user_id in ${db.$client(ids)}`
  await db.$client`delete from verification where identifier in ${db.$client([
    ...sessions.map((s) => `admin-step-up:${s.id}`),
    ...ids.map((id) => `admin-step-up-lock:${id}`),
  ])}`
  await migrator.$client`delete from audit_log where actor_user_id in ${db.$client(ids)}`
  await db.$client`delete from two_factor where user_id in ${db.$client(ids)}`
  await db.$client`delete from session where user_id in ${db.$client(ids)}`
  await db.$client`delete from account where user_id in ${db.$client(ids)}`
  await db.$client`delete from member where user_id in ${db.$client(ids)}`
  await db.$client`delete from organization where id in ${db.$client(ids)}`
  await db.$client`delete from "user" where id in ${db.$client(ids)}`
})

describe('step-up server functions', () => {
  it('reports status, sends an email code through the email queue and verifies it', async () => {
    runtimeRef.current = createRuntime()
    const admin = await signUpAdmin()
    const before = await call<Status>(getStepUpStatus, admin.context)
    expect(before).toMatchObject({
      enforced: false,
      verified: null,
      methods: ['email_otp', 'password'],
      rescueMode: false,
      lockedUntil: null,
      code: null,
    })
    expect(before.email).toMatch(/\*\*\*@/)

    const sent = await call<{ ok: boolean; resendAt: string }>(sendStepUpCode, admin.context, {
      method: 'email_otp',
    })
    expect(sent.ok).toBe(true)
    expect(emails.at(-1)).toMatchObject({
      template: 'admin-step-up-code',
      to: admin.email,
      props: { otp: expect.stringMatching(/^\d{6}$/), expiresInMinutes: 10 },
    })
    expect(
      await call<Result>(sendStepUpCode, admin.context, { method: 'email_otp' }),
    ).toMatchObject({
      ok: false,
      error: 'STEP_UP_RESEND_COOLDOWN',
      details: { resendAt: sent.resendAt },
    })

    const code = lastCode(admin.email)
    expect(
      await call<Result>(verifyStepUp, admin.context, {
        method: 'email_otp',
        code: code === '000000' ? '111111' : '000000',
      }),
    ).toMatchObject({ ok: false, error: 'STEP_UP_INVALID', details: { attemptsRemaining: 2 } })
    expect(
      await call<Result>(verifyStepUp, admin.context, { method: 'email_otp', code }),
    ).toMatchObject({
      ok: true,
      method: 'email_otp',
    })
    const after = await call<Status>(getStepUpStatus, admin.context)
    expect(after.verified?.method).toBe('email_otp')
    const remaining = Date.parse(after.verified?.expiresAt ?? '') - Date.now()
    expect(remaining).toBeGreaterThan(9 * 60_000)
    expect(remaining).toBeLessThanOrEqual(templateConfig.admin.stepUpMinutes * 60_000)
    expect(events).toEqual([])
  })

  it('verifies with the account password', async () => {
    runtimeRef.current = createRuntime()
    const admin = await signUpAdmin()
    expect(
      await call<Result>(verifyStepUp, admin.context, { method: 'password', password: 'nope' }),
    ).toMatchObject({ ok: false, error: 'STEP_UP_INVALID' })
    expect(
      await call<Result>(verifyStepUp, admin.context, { method: 'password', password: PASSWORD }),
    ).toMatchObject({ ok: true, method: 'password' })
  })

  it('lists the available methods when a sensitive action is refused', async () => {
    runtimeRef.current = createRuntime()
    overrideStepUpEnforcedForTesting(true)
    try {
      const admin = await signUpAdmin()
      const error = await runAdminAction(admin.context, 'credits.adjust', async () => 'ran').catch(
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).toJSON()).toMatchObject({
        error: { code: 'STEP_UP_REQUIRED', details: { methods: ['email_otp', 'password'] } },
      })
      // MCP 等无会话的调用没有可在此完成的方式
      const noSession = await runAdminAction(
        { ...admin.context, session: null },
        'credits.adjust',
        async () => 'ran',
      ).catch((e: unknown) => e)
      expect((noSession as AppError).publicDetails).toEqual({ methods: [] })
    } finally {
      overrideStepUpEnforcedForTesting(undefined)
    }
  })
})

describe('step-up rescue', () => {
  async function twoFactorAdmin() {
    const admin = await signUpAdmin()
    const key = (await (runtimeRef.current as WebRuntime).auth.$context).secretConfig
    await db.$client`insert into two_factor (id, secret, backup_codes, user_id, verified, created_at, updated_at)
      values (${newId()}, ${await symmetricEncrypt({ key, data: 'totp-secret' })},
        ${await symmetricEncrypt({ key, data: '[]' })}, ${admin.id}, true, now(), now())`
    await db.$client`update "user" set two_factor_enabled=true where id=${admin.id}`
    return admin
  }

  it('lets a listed admin re-verify by rescue code and notifies operations', async () => {
    runtimeRef.current = createRuntime()
    const admin = await twoFactorAdmin()
    runtimeRef.current = createRuntime({
      ADMIN_STEP_UP_RESCUE: '1',
      BOOTSTRAP_ADMIN_EMAILS: admin.email,
    })
    expect(await call<Status>(getStepUpStatus, admin.context)).toMatchObject({
      methods: ['totp', 'backup_code', 'rescue'],
      rescueMode: true,
    })
    expect(await call<Result>(sendStepUpCode, admin.context, { method: 'rescue' })).toMatchObject({
      ok: true,
    })
    const verified = await call<Result>(verifyStepUp, admin.context, {
      method: 'rescue',
      code: lastCode(admin.email),
    })
    expect(verified).toMatchObject({ ok: true, method: 'rescue' })
    const [audit] = await db.$client<{ id: string }[]>`
      select id from audit_log where actor_user_id=${admin.id} and action='admin.step_up.verified'`
    expect(events.at(-1)).toMatchObject({
      v: 1,
      operations: [{ event: 'admin.step_up.rescue', sourceId: audit?.id }],
    })
  })

  it('does not offer rescue outside the list or while the switch is off', async () => {
    runtimeRef.current = createRuntime()
    const admin = await twoFactorAdmin()
    const count = events.length
    runtimeRef.current = createRuntime({
      ADMIN_STEP_UP_RESCUE: '1',
      BOOTSTRAP_ADMIN_EMAILS: `other@${domain}`,
    })
    expect(await call<Status>(getStepUpStatus, admin.context)).toMatchObject({
      methods: ['totp', 'backup_code'],
      rescueMode: true,
      email: null,
    })
    expect(await call<Result>(sendStepUpCode, admin.context, { method: 'rescue' })).toMatchObject({
      ok: false,
      error: 'STEP_UP_METHOD_UNAVAILABLE',
    })
    runtimeRef.current = createRuntime({ BOOTSTRAP_ADMIN_EMAILS: admin.email })
    expect(await call<Status>(getStepUpStatus, admin.context)).toMatchObject({
      methods: ['totp', 'backup_code'],
      rescueMode: false,
    })
    expect(
      await call<Result>(verifyStepUp, admin.context, { method: 'rescue', code: '123456' }),
    ).toMatchObject({ ok: false, error: 'STEP_UP_METHOD_UNAVAILABLE' })
    expect(events).toHaveLength(count)
  })
})
