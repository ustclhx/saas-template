import { createAuth, parseAuthEnv } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { adminStepUp, auditLog, dbSettingStore, setting } from '@saas/db'
import type { KeyValueStore } from '@saas/platform'
import { AppError, newId } from '@saas/shared'
import { and, count, eq, isNotNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminMcpConfigSchema } from '../../../plugins/admin-mcp/src/config.ts'
import { tokenTerms } from '../../../plugins/admin-mcp/src/web/api-tokens.ts'
import { adminCache, createAdminTestDb, rateLimiter } from './admin-test-resources.ts'

// add-admin-step-up tasks.md 1.4：守卫测试。
// 表驱动遍历登记表中可能敏感的每个动作：管理员会话未重新验证时调用其入口，断言 STEP_UP_REQUIRED
// 且业务表与审计不变；为该会话写入有效的 admin_step_up 后，同样的调用通过守卫。
// 再遍历 `never` 项，断言无需重新验证。只替换 Server Function 传输与请求环境，业务与数据库保持真实。

const request = vi.hoisted(() => ({ headers: new Headers() }))
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
  getRequest: () => ({ headers: request.headers }),
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}))
vi.mock('../src/features/admin/admin.functions.ts', () => ({ adminMiddleware: {} }))
vi.mock('../src/server/runtime.ts', () => ({ getWebRuntime: () => runtimeRef.current }))

import { createAdminApiTokenFn } from '../../../plugins/admin-mcp/src/web/api-tokens.functions.ts'
import { type AdminActionContext, runAdminAction } from '../src/features/admin/action.ts'
import {
  getAdminActionDefinition,
  listAdminActionNames,
  requiresStepUp,
} from '../src/features/admin/actions.registry.ts'
import { adjustCredits } from '../src/features/admin/credits.functions.ts'
import { saveAdminFeatureModels } from '../src/features/admin/feature-models.functions.ts'
import { executeAdminAuthAction } from '../src/features/admin/impersonation.server.ts'
import { handleAuthRequest } from '../src/features/admin/impersonation-http.ts'
import { saveAdminSettings } from '../src/features/admin/settings.functions.ts'
import { readRuntimeSettings, writeRuntimeSetting } from '../src/features/admin/settings.ts'
import { saveOperationsSettings } from '../src/features/admin/settings-operations.functions.ts'
import {
  overrideStepUpEnforcedForTesting,
  STEP_UP_REQUIRED,
} from '../src/features/admin/step-up/check.ts'
import { saveAdminModel } from '../src/features/ai/admin-models.functions.ts'
import {
  completeAdminRefund,
  replayAdminWebhook,
  reviewAdminRefund,
} from '../src/features/billing/admin.functions.ts'
import { saveAdminPlanModels } from '../src/features/billing/admin-plans.functions.ts'
import { createWebAuth } from '../src/server/auth.ts'
import type { WebRuntime } from '../src/server/runtime.ts'
import { templateConfig } from '../src/server/template-config.ts'

const APP_URL = 'http://localhost:3000'
const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const domain = `${newId()}.step-up-guard.example`
const db = createAdminTestDb()
const migrator = createAdminTestDb('migrator')
const runtimeConfig = {
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

function createRuntime(): WebRuntime {
  const requestMeta = { clientIp: '203.0.113.21', requestId: newId() }
  const create = (database: typeof db, cache: KeyValueStore = adminCache) =>
    createWebAuth(runtimeConfig, database, {
      cache,
      rateLimiter,
      clientIp: requestMeta.clientIp,
      sendEmail: async () => {},
    })
  const queue = { available: true as const, value: { send: async () => {} } }
  const runtime = {
    // 支付运行时只需测试模式；未配置支付平台时 providers 为空
    config: { ...parseAuthEnv(runtimeConfig, templateConfig), PAYMENT_MODE: 'test' },
    db,
    publicDb: db,
    cache: adminCache,
    rateLimiter,
    requestMeta,
    emailQueue: queue,
    eventsQueue: queue,
    ai: { available: true, value: { config: {}, workersAi: { available: true } } },
    auth: create(db),
    createAuth: create,
    handleAuthRequest: (req: Request) => handleAuthRequest(req, runtime as unknown as WebRuntime),
  }
  return runtime as unknown as WebRuntime
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((part) => part.split(';')[0] ?? '')
    .join('; ')
}

async function signUp(role: 'admin' | 'user') {
  const email = `${newId()}@${domain}`
  const response = await auth.handler(
    new Request(`${APP_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Step-up guard' }),
    }),
  )
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  await db.$client`update "user" set role=${role} where id=${user.id}`
  const [row] = await db.$client<{ id: string }[]>`select id from session where user_id=${user.id}`
  return {
    id: user.id,
    sessionId: row?.id as string,
    headers: new Headers({ cookie: cookies(response), origin: APP_URL }),
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
const settle = (run: () => Promise<unknown>): Promise<Outcome> =>
  run().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  )
const STEP_UP_MESSAGE = 'Re-verify your identity to continue'
/** 入口可能抛出 AppError，也可能把错误码或消息包装为 `{ ok: false, error }` 返回 */
function stepUpRejected(outcome: Outcome) {
  if (!outcome.ok)
    return outcome.error instanceof AppError && outcome.error.code === STEP_UP_REQUIRED
  const value = outcome.value as { ok?: boolean; error?: unknown } | Response
  if (value instanceof Response) return value.status === 403
  return value?.ok === false && [STEP_UP_REQUIRED, STEP_UP_MESSAGE].includes(String(value.error))
}

let admin: Awaited<ReturnType<typeof signUp>>
let context: AdminActionContext
const workspaceId = newId()
const planId = newId()
const modelKeys: string[] = []
const settingKeys = ['operations.telegramChatId', 'operations.discordWebhookUrl']
let originalSettings: { key: string; value: unknown }[] = []

const call = (fn: unknown, data: unknown) =>
  (fn as (input: { context: AdminActionContext; data: unknown }) => Promise<unknown>)({
    context,
    data,
  })
const adminAudits = async () =>
  (await db.select({ n: count() }).from(auditLog).where(eq(auditLog.actorUserId, admin.id)))[0]?.n
const grantStepUp = () =>
  db.insert(adminStepUp).values({
    sessionId: admin.sessionId,
    userId: admin.id,
    method: 'password',
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  })
const revokeStepUp = () => db.delete(adminStepUp).where(eq(adminStepUp.sessionId, admin.sessionId))

interface GuardCase {
  /** 入口说明 */
  readonly entry: string
  run(): Promise<unknown>
  /** 业务表状态：拒绝前后必须一致 */
  state(): Promise<unknown>
  /** 通过守卫后的断言（默认：不再是 STEP_UP_REQUIRED） */
  allowed?(outcome: Outcome): void | Promise<void>
}

const succeeded = (outcome: Outcome) => {
  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.value).not.toMatchObject({ ok: false })
}
/** 通过守卫、进入业务校验（缺少真实支付平台或申请时以业务错误结束） */
const reachedBusiness = (code: string) => (outcome: Outcome) => {
  expect(outcome).toMatchObject({ ok: true, value: { ok: false, error: code } })
}

const targets = { ban: '', unban: '', impersonate: '' }
const guardCases: Record<string, GuardCase> = {
  'user.ban': {
    entry: 'setAdminUserBan / 原生 /admin/ban-user',
    run: () =>
      executeAdminAuthAction({
        db,
        runtime: createRuntime(),
        headers: admin.headers,
        path: '/admin/ban-user',
        body: { userId: targets.ban, banReason: 'step-up guard' },
      }),
    state: async () => (await db.$client`select banned from "user" where id=${targets.ban}`)[0],
    allowed: async (outcome) => {
      expect(outcome.ok).toBe(true)
      expect((await db.$client`select banned from "user" where id=${targets.ban}`)[0]).toEqual({
        banned: true,
      })
    },
  },
  'user.unban': {
    entry: 'setAdminUserBan / 原生 /admin/unban-user',
    run: () =>
      executeAdminAuthAction({
        db,
        runtime: createRuntime(),
        headers: admin.headers,
        path: '/admin/unban-user',
        body: { userId: targets.unban, banReason: 'step-up guard' },
      }),
    state: async () => (await db.$client`select banned from "user" where id=${targets.unban}`)[0],
    allowed: async (outcome) => {
      expect(outcome.ok).toBe(true)
      expect((await db.$client`select banned from "user" where id=${targets.unban}`)[0]).toEqual({
        banned: false,
      })
    },
  },
  'user.impersonate': {
    entry: 'startAdminImpersonation / 原生 /admin/impersonate-user',
    run: () =>
      executeAdminAuthAction({
        db,
        runtime: createRuntime(),
        headers: admin.headers,
        path: '/admin/impersonate-user',
        body: { userId: targets.impersonate },
      }),
    state: async () =>
      (
        await db.$client`select count(*)::int as n from session where impersonated_by=${admin.id}`
      )[0],
    allowed: async (outcome) => {
      expect(outcome.ok && (outcome.value as Response).ok).toBe(true)
      expect(
        (
          await db.$client`select count(*)::int as n from session where impersonated_by=${admin.id}`
        )[0],
      ).toEqual({ n: 1 })
    },
  },
  'credits.adjust': {
    entry: 'adjustCredits',
    run: () =>
      call(adjustCredits, {
        kind: 'grant',
        adjustmentId: newId(),
        workspaceId,
        amount: 10,
        expiresAt: null,
        reason: 'step-up guard',
      }),
    state: async () =>
      (
        await db.$client`select count(*)::int as n from credit_grant where workspace_id=${workspaceId}`
      )[0],
    allowed: succeeded,
  },
  'billing.webhook_replay': {
    entry: 'replayAdminWebhook',
    run: () => call(replayAdminWebhook, { webhookEventId: newId() }),
    state: async () => null,
    allowed: reachedBusiness('WEBHOOK_NOT_REPLAYABLE'),
  },
  'billing.refund_review': {
    entry: 'reviewAdminRefund（通过）',
    run: () =>
      call(reviewAdminRefund, { requestId: newId(), decision: 'approve', reviewNote: 'ok' }),
    state: async () => null,
    allowed: (outcome) => {
      expect(outcome).toMatchObject({ ok: true, value: { ok: false } })
      expect(stepUpRejected(outcome)).toBe(false)
    },
  },
  'billing.refund_manual': {
    entry: 'completeAdminRefund',
    run: () =>
      call(completeAdminRefund, { requestId: newId(), providerRefundId: 're_1', proof: 'bank' }),
    state: async () => null,
    allowed: (outcome) => {
      expect(outcome).toMatchObject({ ok: true, value: { ok: false } })
      expect(stepUpRejected(outcome)).toBe(false)
    },
  },
  'setting.operations.update': {
    entry: 'saveOperationsSettings',
    run: () => call(saveOperationsSettings, { telegramChatId: '-4242' }),
    state: () => dbSettingStore(db).find('operations.telegramChatId'),
    allowed: async (outcome) => {
      expect(outcome).toEqual({ ok: true, value: { ok: true } })
      expect(await dbSettingStore(db).find('operations.telegramChatId')).toBe('-4242')
    },
  },
  'setting.update': {
    // 后台表单不含密钥项；密钥项目前只经 MCP settings.set 写入（无会话，见下方 MCP 用例）
    entry: 'setting.update 包装（密钥项改动）',
    run: () => {
      const key = 'operations.discordWebhookUrl'
      const value = 'https://discord.com/api/webhooks/1/step-up-guard'
      return runAdminAction(
        context,
        { name: 'setting.update', input: { entries: [[key, value]] } },
        (scope) => writeRuntimeSetting(scope, key, value),
      )
    },
    state: () => dbSettingStore(db).find('operations.discordWebhookUrl'),
    allowed: async (outcome) => {
      expect(outcome.ok).toBe(true)
      expect(await dbSettingStore(db).find('operations.discordWebhookUrl')).toContain('step-up')
    },
  },
  'ai.model_save': {
    entry: 'saveAdminModel（新建）',
    run: () => {
      const key = `step-up-guard-${newId().slice(-12)}`
      modelKeys.push(key)
      return call(saveAdminModel, {
        key,
        kind: 'text',
        provider: 'deepseek',
        providerModelId: 'deepseek-flash',
        pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 },
        paramsSchema: '{}',
        tags: [],
        enabled: false,
        sort: 0,
      })
    },
    state: async () =>
      (
        await db.$client`select count(*)::int as n from ai_model where key like 'step-up-guard-%'`
      )[0],
    allowed: succeeded,
  },
  'admin.plan.models.update': {
    entry: 'saveAdminPlanModels',
    run: () => call(saveAdminPlanModels, { id: planId, models: [] }),
    state: async () => (await db.$client`select features from plan where id=${planId}`)[0],
    allowed: succeeded,
  },
  'admin.api_token.create': {
    entry: 'createAdminApiTokenFn（admin-mcp 插件）',
    run: () =>
      call(createAdminApiTokenFn, {
        name: 'step-up guard',
        write: false,
        days: tokenTerms(
          adminMcpConfigSchema.parse(templateConfig.plugins['admin-mcp'] ?? {}).maxTokenDays,
        )[0],
      }),
    state: async () =>
      (
        await db.$client`select count(*)::int as n from admin_api_token where user_id=${admin.id}`
      )[0],
    allowed: (outcome) =>
      expect(outcome).toMatchObject({ ok: true, value: { token: expect.any(String) } }),
  },
  'admin.confirmation.confirm': {
    // 确认页 Server Function 由第 3 组实现，届时替换为真实入口
    entry: 'runAdminAction（确认执行入口待第 3 组实现）',
    run: () =>
      runAdminAction(context, 'admin.confirmation.confirm', ({ audit }) =>
        audit({ action: 'test.step_up_guard', targetType: 'test' }),
      ),
    state: async () => null,
    allowed: (outcome) => expect(outcome.ok).toBe(true),
  },
}

beforeAll(async () => {
  // 强制开关上线前默认关闭（STEP_UP_ENFORCED），守卫测试强制开启以覆盖拒绝与放行
  overrideStepUpEnforcedForTesting(true)
  runtimeRef.current = createRuntime()
  admin = await signUp('admin')
  context = {
    db,
    admin: { id: admin.id },
    ip: '203.0.113.21',
    session: { id: admin.sessionId, userId: admin.id },
  }
  targets.ban = (await signUp('user')).id
  targets.unban = (await signUp('user')).id
  targets.impersonate = (await signUp('user')).id
  await db.$client`update "user" set banned=true, ban_reason='fixture' where id=${targets.unban}`
  await db.$client`insert into organization(id,name,slug) values(${workspaceId},'Step-up guard',${workspaceId})`
  await db.$client`insert into plan(id,key,name,type,credits,features,active) values(${planId},${planId},'Step-up guard','subscription',100,'{"models":[],"maxConcurrentTasks":1,"maxSeats":1,"storageGb":1,"publicApi":false,"priorityQueue":false,"watermark":false}'::jsonb,false)`
  originalSettings = await db.$client<{ key: string; value: unknown }[]>`
    select key, value from setting where key in ${db.$client(settingKeys)}`
})

afterAll(async () => {
  overrideStepUpEnforcedForTesting(undefined)
  const users = await db.$client<
    { id: string }[]
  >`select id from "user" where email like ${`%@${domain}`}`
  const ids = users.map((u) => u.id)
  await db.delete(setting).where(sql`${setting.key} in ${settingKeys}`)
  for (const row of originalSettings) await db.insert(setting).values(row)
  if (ids.length) {
    await migrator.$client`delete from audit_log where actor_user_id in ${db.$client(ids)} or workspace_id=${workspaceId}`
    await db.$client`delete from admin_api_token where user_id in ${db.$client(ids)}`
    await db.$client`delete from session where user_id in ${db.$client(ids)}`
    await db.$client`delete from account where user_id in ${db.$client(ids)}`
    await db.$client`delete from member where user_id in ${db.$client(ids)}`
    await db.$client`delete from organization where id in ${db.$client(ids)}`
  }
  await db.$client`delete from credit_ledger where workspace_id=${workspaceId}`
  await db.$client`delete from credit_grant where workspace_id=${workspaceId}`
  await db.$client`delete from organization where id=${workspaceId}`
  await db.$client`delete from plan where id=${planId}`
  if (modelKeys.length) await db.$client`delete from ai_model where key in ${db.$client(modelKeys)}`
  if (ids.length) await db.$client`delete from "user" where id in ${db.$client(ids)}`
  await Promise.all([db.$client.end(), migrator.$client.end()])
})

describe('敏感后台动作的重新验证守卫', () => {
  it('守卫用例覆盖登记表中全部可能敏感的动作', () => {
    const sensitive = listAdminActionNames().filter(
      (name) => getAdminActionDefinition(name)?.stepUp !== 'never',
    )
    expect(Object.keys(guardCases).sort()).toEqual(sensitive.sort())
  })

  for (const [name, guard] of Object.entries(guardCases)) {
    it(`${name}：未验证被拒且不留写入，验证后通过（${guard.entry}）`, async () => {
      const before = { state: await guard.state(), audits: await adminAudits() }
      const denied = await settle(guard.run)
      expect(stepUpRejected(denied), JSON.stringify(denied)).toBe(true)
      expect({ state: await guard.state(), audits: await adminAudits() }).toEqual(before)

      await grantStepUp()
      try {
        const allowed = await settle(guard.run)
        expect(stepUpRejected(allowed), JSON.stringify(allowed)).toBe(false)
        await guard.allowed?.(allowed)
      } finally {
        await revokeStepUp()
      }
    })
  }

  it('原生 /api/auth/admin/ban-user 同样要求重新验证', async () => {
    const target = (await signUp('user')).id
    const response = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/admin/ban-user`, {
        method: 'POST',
        headers: new Headers([...admin.headers, ['content-type', 'application/json']]),
        body: JSON.stringify({ userId: target, banReason: 'native' }),
      }),
      createRuntime(),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: STEP_UP_REQUIRED })
    expect((await db.$client`select banned from "user" where id=${target}`)[0]).toEqual({
      banned: false,
    })
  })

  it('过期的验证与无会话的调用（MCP）都不放行', async () => {
    await db.insert(adminStepUp).values({
      sessionId: admin.sessionId,
      userId: admin.id,
      method: 'password',
      verifiedAt: new Date(Date.now() - 11 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    })
    try {
      expect(
        stepUpRejected(await settle(guardCases['credits.adjust']?.run as () => Promise<unknown>)),
      ).toBe(true)
    } finally {
      await revokeStepUp()
    }
    await expect(
      runAdminAction({ db, admin: { id: admin.id } }, 'credits.adjust', async () => 'x'),
    ).rejects.toMatchObject({ code: STEP_UP_REQUIRED })
  })
})

describe('日常后台动作无需重新验证', () => {
  it('遍历 never 项：未验证的会话与无会话调用都可执行', async () => {
    const never = listAdminActionNames().filter(
      (name) => getAdminActionDefinition(name)?.stepUp === 'never',
    )
    expect(never.length).toBeGreaterThan(5)
    for (const name of never) {
      for (const ctx of [context, { db, admin: { id: admin.id } }]) {
        await expect(
          runAdminAction(ctx, name as 'waitlist.invite', ({ audit }) =>
            audit({ action: 'test.step_up_never', targetType: 'test', targetId: name }),
          ),
          name,
        ).resolves.toBeUndefined()
      }
    }
  })

  it('按输入判定的动作在日常输入下无需重新验证', async () => {
    expect(
      await requiresStepUp(
        { name: 'billing.refund_review', input: { decision: 'reject' } },
        { db },
      ),
    ).toBe(false)
    const rejected = await settle(() =>
      call(reviewAdminRefund, { requestId: newId(), decision: 'reject', reviewNote: 'no' }),
    )
    expect(stepUpRejected(rejected)).toBe(false)

    // 普通设置与功能模型（非密钥）直接保存
    const current = await readRuntimeSettings(db)
    expect(await call(saveAdminSettings, current)).toMatchObject({ ok: true })
    expect(await call(saveAdminFeatureModels, { values: {} })).toMatchObject({ ok: true })

    // 原样提交密钥项现值不算改动
    const [stored] = await db
      .select({ value: setting.value })
      .from(setting)
      .where(and(eq(setting.key, 'operations.discordWebhookUrl'), isNotNull(setting.value)))
    expect(
      await requiresStepUp(
        {
          name: 'setting.update',
          input: { entries: [['operations.discordWebhookUrl', stored?.value ?? '']] },
        },
        { db },
      ),
    ).toBe(false)
  })
})
