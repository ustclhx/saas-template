import { MODEL_CACHE_KEY } from '@saas/ai'
import { parseAuthEnv } from '@saas/auth'
import { grant } from '@saas/credits'
import {
  adminApiToken,
  adminPendingAction,
  aiModel,
  auditLog,
  cleanupAdminPendingActions,
  creditGrant,
  dbSettingStore,
  setting,
} from '@saas/db'
import type { RateLimiter } from '@saas/platform'
import { newId } from '@saas/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminCache, cacheValues, createAdminTestDb } from './admin-test-resources.ts'
import { deleteStepUpSessions, type StepUpSession, stepUpSession } from './step-up-fixtures.ts'

// add-admin-step-up 第 3 组（任务 3.1–3.4）：AI 经 MCP 发起敏感操作 → 待确认记录 → 后台确认 / 拒绝。
// MCP 走真实 SDK 客户端；确认与拒绝直接调用 Server Function 的 handler（替换 Start 传输与请求环境），
// 业务与数据库保持真实。

const runtimeRef = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('@tanstack/react-start', () => ({
  createMiddleware: () => ({ server: () => ({}) }),
  createServerOnlyFn: (fn: unknown) => fn,
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
vi.mock('../src/server/runtime.ts', () => ({
  getWebRuntime: () => runtimeRef.current,
  pluginUnavailable: () => false,
}))

import {
  confirmAdminConfirmation,
  getAdminConfirmation,
  rejectAdminConfirmation,
} from '../../../plugins/admin-mcp/src/web/confirmations.functions.ts'
import { respondToAdminMcp } from '../../../plugins/admin-mcp/src/web/mcp.ts'
import {
  createAdminApiToken,
  revokeAdminApiToken,
} from '../../../plugins/admin-mcp/src/web/tokens.ts'
import { connectAdminMcpTestClient } from '../../../plugins/admin-mcp/test/client.ts'
import type { AdminActionContext } from '../src/features/admin/action.ts'
import { confirmationKeyName } from '../src/features/admin/confirmations/secret.ts'
import {
  getPendingAction,
  MAX_PENDING_PER_TOKEN,
} from '../src/features/admin/confirmations/service.ts'
import { adminCreditBalance } from '../src/features/admin/credits.ts'
import { STEP_UP_REQUIRED } from '../src/features/admin/step-up/check.ts'
import { templateConfig } from '../src/server/template-config.ts'

const APP_URL = 'https://admin-confirm.example.test'
const url = new URL('/api/admin/mcp', APP_URL)
const domain = `${newId()}.admin-confirm.example`
const db = createAdminTestDb()
const migrator = createAdminTestDb('migrator')
const SECRET_KEY = 'operations.telegramBotToken'

const runtimeConfig = {
  APP_URL,
  BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  GOOGLE_CLIENT_ID: 'test',
  GOOGLE_CLIENT_SECRET: 'test',
  GITHUB_CLIENT_ID: 'test',
  GITHUB_CLIENT_SECRET: 'test',
}
const queue = { available: true as const, value: { send: async () => {} } }
const rateLimiter = {
  limit: vi.fn<RateLimiter['limit']>().mockResolvedValue({ success: true }),
}
const mcpRuntime = {
  db,
  config: { APP_URL },
  cache: adminCache,
  rateLimiter,
  requestMeta: { requestId: newId(), clientIp: null },
}

type Context = AdminActionContext & { session: StepUpSession }
interface Admin {
  readonly id: string
  /** 已重新验证的会话 */
  readonly verified: Context
  /** 未重新验证的会话 */
  readonly unverified: Context
}

const workspaces: string[] = []
const modelKeys: string[] = []
let originalSecret: unknown

async function createAdmin(): Promise<Admin> {
  const id = newId()
  await db.$client`insert into "user"(id,name,email,role) values(${id},'Confirm admin',${`${id}@${domain}`},'admin')`
  const base = { db, admin: { id }, ip: '203.0.113.30' }
  return {
    id,
    verified: { ...base, session: await stepUpSession(db, id) },
    unverified: { ...base, session: await stepUpSession(db, id, { verified: false }) },
  }
}

async function createWorkspace() {
  const id = newId()
  workspaces.push(id)
  await db.$client`insert into organization(id,name,slug) values(${id},'Confirm space',${`confirm-${id}`})`
  return { id, slug: `confirm-${id}` }
}

async function issue(adminId: string, write = true) {
  return createAdminApiToken(db, adminId, {
    name: 'agent',
    scopes: write ? ['admin:read', 'admin:write'] : ['admin:read'],
  })
}

function connect(token: string) {
  return connectAdminMcpTestClient(url, token, (input, init) =>
    respondToAdminMcp(new Request(input, init), () => mcpRuntime),
  )
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const client = await connect(token)
  try {
    return (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      structuredContent: Record<string, unknown> & {
        confirmationId: string
        error?: { code: string }
      }
    }
  } finally {
    await client.close()
  }
}

type FnResult =
  | { ok: true; status: string; result: Record<string, unknown> }
  | {
      ok: false
      error: string
    }
const confirm = (context: Context, id: string) =>
  (confirmAdminConfirmation as unknown as (input: unknown) => Promise<FnResult>)({
    context,
    data: { id },
  })
const view = (context: Context, id: string) =>
  (getAdminConfirmation as unknown as (input: unknown) => Promise<Record<string, unknown>>)({
    context,
    data: { id },
  })
const reject = (context: Context, id: string) =>
  (rejectAdminConfirmation as unknown as (input: unknown) => Promise<FnResult>)({
    context,
    data: { id },
  })

const grants = (workspaceId: string) =>
  db.select().from(creditGrant).where(eq(creditGrant.workspaceId, workspaceId))
const audits = (adminId: string) =>
  db.select().from(auditLog).where(eq(auditLog.actorUserId, adminId)).orderBy(auditLog.id)
const record = async (id: string) =>
  (await db.select().from(adminPendingAction).where(eq(adminPendingAction.id, id)))[0]

async function requestGrant(token: string, workspace: string, amount = 100) {
  const response = await call(token, 'credits.adjust', {
    workspace,
    kind: 'grant',
    amount,
    reason: 'Agent requested top-up',
  })
  expect(response.isError).toBeFalsy()
  expect(response.structuredContent.status).toBe('needs_owner_confirm')
  return response.structuredContent.confirmationId
}

beforeAll(async () => {
  runtimeRef.current = {
    config: { ...parseAuthEnv(runtimeConfig, templateConfig), PAYMENT_MODE: 'test' },
    db,
    cache: adminCache,
    emailQueue: queue,
    eventsQueue: queue,
    requestMeta: { clientIp: '203.0.113.30', requestId: newId() },
    ai: { available: true, value: { config: {}, workersAi: { available: true } } },
  }
  originalSecret = await dbSettingStore(db).find(SECRET_KEY)
})

afterAll(async () => {
  await db.delete(setting).where(eq(setting.key, SECRET_KEY))
  if (originalSecret !== undefined)
    await db.insert(setting).values({ key: SECRET_KEY, value: originalSecret })
  cacheValues.delete(`setting:${SECRET_KEY}`)
  const users = await db.$client<
    { id: string }[]
  >`select id from "user" where email like ${`%@${domain}`}`
  const ids = users.map(({ id }) => id)
  if (ids.length) {
    await migrator.$client`delete from audit_log where actor_user_id in ${db.$client(ids)}`
    await db.$client`delete from admin_pending_action where requested_by in ${db.$client(ids)}`
    await db.$client`delete from admin_api_token where user_id in ${db.$client(ids)}`
  }
  await deleteStepUpSessions(db)
  if (workspaces.length) {
    await migrator.$client`delete from audit_log where workspace_id in ${db.$client(workspaces)}`
    await db.$client`delete from credit_ledger where workspace_id in ${db.$client(workspaces)}`
    await db.$client`delete from credit_grant where workspace_id in ${db.$client(workspaces)}`
    await db.$client`delete from refund_request where workspace_id in ${db.$client(workspaces)}`
    await db.$client`delete from payment where workspace_id in ${db.$client(workspaces)}`
    await db.$client`delete from purchase where workspace_id in ${db.$client(workspaces)}`
    await db.$client`delete from organization where id in ${db.$client(workspaces)}`
  }
  if (modelKeys.length) await db.delete(aiModel).where(inArray(aiModel.key, modelKeys))
  if (ids.length) await db.$client`delete from "user" where id in ${db.$client(ids)}`
  await Promise.all([db.$client.end(), migrator.$client.end()])
})

describe.skipIf(!templateConfig.plugins['admin-mcp'] || !templateConfig.credits.enabled)(
  'AI 发起、管理员确认（credits.adjust）',
  () => {
    it('调用 → needs_owner_confirm → 重新验证后确认 → confirmations.get 为 done，审计带来源', async () => {
      const admin = await createAdmin()
      const { token, metadata } = await issue(admin.id)
      const workspace = await createWorkspace()
      const id = await requestGrant(token, workspace.slug)
      expect(await grants(workspace.id)).toEqual([])
      expect(await audits(admin.id)).toContainEqual(
        expect.objectContaining({
          action: 'admin.confirmation.requested',
          targetId: id,
          meta: expect.objectContaining({
            via: 'mcp',
            tokenId: metadata.id,
            tool: 'credits.adjust',
          }),
        }),
      )
      const pending = await call(token, 'confirmations.get', { id })
      expect(pending.structuredContent).toMatchObject({
        id,
        status: 'pending',
        confirmUrl: `${APP_URL}/admin/confirm/${id}`,
      })

      // 未重新验证的会话确认被拒，记录保持待确认
      await expect(confirm(admin.unverified, id)).rejects.toMatchObject({ code: STEP_UP_REQUIRED })
      expect((await record(id))?.status).toBe('pending')

      const outcome = await confirm(admin.verified, id)
      expect(outcome).toMatchObject({ ok: true, status: 'done', result: { replayed: false } })
      const [granted] = await grants(workspace.id)
      expect(granted).toMatchObject({ amount: 100, source: 'admin' })

      const done = await call(token, 'confirmations.get', { id })
      expect(done.structuredContent).toMatchObject({
        status: 'done',
        result: { workspaceId: workspace.id, kind: 'grant' },
      })
      const trail = await audits(admin.id)
      expect(trail.find(({ action }) => action === 'credits.adjust')).toMatchObject({
        workspaceId: workspace.id,
        meta: {
          via: 'mcp',
          tokenId: metadata.id,
          tool: 'credits.adjust',
          confirmationId: id,
          confirmedBy: admin.id,
          stepUpMethod: 'password',
        },
      })
      expect(trail.map(({ action }) => action)).toContain('admin.confirmation.confirmed')
    })

    it('附加 confirmed 字段被拒、dryRun 只预览、只读令牌无权，均不创建记录', async () => {
      const admin = await createAdmin()
      const write = await issue(admin.id)
      const read = await issue(admin.id, false)
      const workspace = await createWorkspace()
      const args = { workspace: workspace.id, kind: 'grant', amount: 5, reason: 'forged' }
      const forged = await call(write.token, 'credits.adjust', { ...args, confirmed: true })
      expect(forged.structuredContent.error?.code).toBe('INVALID_TOOL_ARGUMENTS')
      const preview = await call(write.token, 'credits.adjust', { ...args, dryRun: true })
      expect(preview.structuredContent).toMatchObject({
        dryRun: true,
        display: { operation: 'grant', amount: 5, workspace: { id: workspace.id } },
      })
      const denied = await call(read.token, 'credits.adjust', args)
      expect(denied.structuredContent.error?.code).toBe('INSUFFICIENT_SCOPE')
      expect(
        await db
          .select()
          .from(adminPendingAction)
          .where(eq(adminPendingAction.requestedBy, admin.id)),
      ).toEqual([])
      expect(await grants(workspace.id)).toEqual([])
    })

    it(`每个令牌最多 ${MAX_PENDING_PER_TOKEN} 条待确认记录`, async () => {
      const admin = await createAdmin()
      const { token, metadata } = await issue(admin.id)
      const workspace = await createWorkspace()
      await db.insert(adminPendingAction).values(
        Array.from({ length: MAX_PENDING_PER_TOKEN }, () => ({
          tool: 'credits.adjust',
          action: 'credits.adjust',
          tokenId: metadata.id,
          requestedBy: admin.id,
          summary: 'fixture',
          payload: {},
          display: {},
          expiresAt: new Date(Date.now() + 60_000),
        })),
      )
      const limited = await call(token, 'credits.adjust', {
        workspace: workspace.id,
        kind: 'grant',
        amount: 1,
        reason: 'over the limit',
      })
      expect(limited.structuredContent.error?.code).toBe('CONFIRMATION_LIMIT_REACHED')
    })

    it('双击确认只执行一次，另一次看到已处理', async () => {
      const admin = await createAdmin()
      const { token } = await issue(admin.id)
      const workspace = await createWorkspace()
      const id = await requestGrant(token, workspace.id)
      const outcomes = await Promise.all([confirm(admin.verified, id), confirm(admin.verified, id)])
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
      expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({
        error: 'CONFIRMATION_NOT_PENDING',
      })
      expect(await grants(workspace.id)).toHaveLength(1)
      expect((await record(id))?.status).toBe('done')
    })

    it('确认与其他管理员的拒绝竞争时只有一个生效，状态与审计一致', async () => {
      const owner = await createAdmin()
      const other = await createAdmin()
      const { token } = await issue(owner.id)
      const workspace = await createWorkspace()
      const id = await requestGrant(token, workspace.id)
      const [confirmed, rejected] = await Promise.all([
        confirm(owner.verified, id),
        reject(other.unverified, id),
      ])
      expect([confirmed.ok, rejected.ok].filter(Boolean)).toHaveLength(1)
      const final = await record(id)
      if (confirmed.ok) {
        expect(final?.status).toBe('done')
        expect(await grants(workspace.id)).toHaveLength(1)
        expect((await audits(other.id)).map(({ action }) => action)).not.toContain(
          'admin.confirmation.rejected',
        )
      } else {
        expect(final).toMatchObject({ status: 'rejected', decidedBy: other.id })
        expect(await grants(workspace.id)).toEqual([])
        expect((await audits(other.id)).map(({ action }) => action)).toContain(
          'admin.confirmation.rejected',
        )
      }
    })

    it('非发起人只能拒绝，不能确认', async () => {
      const owner = await createAdmin()
      const other = await createAdmin()
      const { token } = await issue(owner.id)
      const workspace = await createWorkspace()
      const id = await requestGrant(token, workspace.id)
      expect(await confirm(other.verified, id)).toMatchObject({
        ok: false,
        error: 'CONFIRMATION_FORBIDDEN',
      })
      expect((await record(id))?.status).toBe('pending')
      expect(await reject(other.unverified, id)).toMatchObject({ ok: true, status: 'rejected' })
      expect(await confirm(owner.verified, id)).toMatchObject({
        ok: false,
        error: 'CONFIRMATION_NOT_PENDING',
      })
      expect(await grants(workspace.id)).toEqual([])
      const agentView = await call(token, 'confirmations.get', { id })
      expect(agentView.structuredContent).toMatchObject({ status: 'rejected' })
    })

    it('过期后不可确认或拒绝，读取时惰性置为 expired', async () => {
      const admin = await createAdmin()
      const { token } = await issue(admin.id)
      const workspace = await createWorkspace()
      const id = await requestGrant(token, workspace.id)
      await db
        .update(adminPendingAction)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(adminPendingAction.id, id))
      expect(await confirm(admin.verified, id)).toMatchObject({
        ok: false,
        error: 'CONFIRMATION_EXPIRED',
      })
      expect(await reject(admin.verified, id)).toMatchObject({
        ok: false,
        error: 'CONFIRMATION_EXPIRED',
      })
      expect((await getPendingAction(db, id))?.status).toBe('expired')
      expect(await grants(workspace.id)).toEqual([])
    })

    it('吊销发起令牌后确认以 TOKEN_REVOKED 失败，不执行', async () => {
      const admin = await createAdmin()
      const { token, metadata } = await issue(admin.id)
      const workspace = await createWorkspace()
      const id = await requestGrant(token, workspace.id)
      expect(await db.transaction((tx) => revokeAdminApiToken(tx, admin.id, metadata.id))).toBe(
        true,
      )
      expect(await confirm(admin.verified, id)).toMatchObject({
        ok: true,
        status: 'failed',
        result: { code: 'TOKEN_REVOKED' },
      })
      expect(await record(id)).toMatchObject({
        status: 'failed',
        result: { code: 'TOKEN_REVOKED' },
      })
      expect(await grants(workspace.id)).toEqual([])
      expect((await audits(admin.id)).map(({ action }) => action)).toContain(
        'admin.confirmation.failed',
      )
    })

    it('积分调整不以余额变化阻断：发起后余额变化仍确认成功，确认页按实时余额展示，审计正确', async () => {
      const admin = await createAdmin()
      const { token, metadata } = await issue(admin.id)
      const workspace = await createWorkspace()
      const seed = (amount: number) =>
        grant(db, { workspaceId: workspace.id, source: 'admin', sourceRef: newId(), amount })
      await seed(40)
      const id = await requestGrant(token, workspace.id)
      // 发起时余额快照只作注明
      expect((await record(id))?.display).toMatchObject({ balance: { before: 40, after: 140 } })
      // 发起后余额变化（另一笔发放）：确认页按打开时的实时余额计算「当前 → 执行后」
      await seed(5)
      const page = await view(admin.verified, id)
      expect(page).toMatchObject({ found: true, liveBalance: 45 })
      expect(await confirm(admin.verified, id)).toMatchObject({ ok: true, status: 'done' })
      expect(await adminCreditBalance(db, workspace.id)).toBe(145)
      expect(
        (await grants(workspace.id)).map(({ amount }) => amount).sort((a, b) => a - b),
      ).toEqual([5, 40, 100])
      const [adjusted] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'credits.adjust'), eq(auditLog.workspaceId, workspace.id)))
      expect(adjusted).toMatchObject({
        actorUserId: admin.id,
        meta: {
          via: 'mcp',
          tokenId: metadata.id,
          confirmationId: id,
          confirmedBy: admin.id,
          input: { kind: 'grant', amount: 100, workspaceId: workspace.id },
        },
      })
      // 已结束的记录不再读实时余额
      expect(await view(admin.verified, id)).toMatchObject({ liveBalance: null })
    })
  },
)

describe.skipIf(!templateConfig.plugins['admin-mcp'])('密钥参数与目标快照', () => {
  it('确认后写入密钥、清空密文并删除数据密钥', async () => {
    const admin = await createAdmin()
    const { token } = await issue(admin.id)
    const value = `123456:${newId().replaceAll('-', '')}`
    const response = await call(token, 'settings.set', { key: SECRET_KEY, value })
    const id = response.structuredContent.confirmationId
    expect(response.structuredContent.status).toBe('needs_owner_confirm')
    const pending = await getPendingAction(db, id)
    expect(pending).toMatchObject({
      hasSecret: true,
      display: { key: SECRET_KEY, after: { isSet: true, last4: value.slice(-4) } },
    })
    expect(JSON.stringify(await record(id))).not.toContain(value)
    expect(await adminCache.get(confirmationKeyName(id))).toEqual(expect.any(String))

    expect(await confirm(admin.verified, id)).toMatchObject({ ok: true, status: 'done' })
    expect(await dbSettingStore(db).find(SECRET_KEY)).toBe(value)
    expect((await record(id))?.secretCiphertext).toBeNull()
    expect(await adminCache.get(confirmationKeyName(id))).toBeNull()
    const trail = await audits(admin.id)
    expect(trail.find(({ action }) => action === 'setting.updated')).toMatchObject({
      meta: { via: 'mcp', confirmationId: id, oldValue: '[redacted]', newValue: '[redacted]' },
    })
    expect(JSON.stringify(trail)).not.toContain(value)
  })

  it('数据密钥过期（缓存键消失）后密文不可解，确认以 SECRET_UNAVAILABLE 失败', async () => {
    const admin = await createAdmin()
    const { token } = await issue(admin.id)
    const before = await dbSettingStore(db).find(SECRET_KEY)
    const response = await call(token, 'settings.set', {
      key: SECRET_KEY,
      value: `654321:${newId().replaceAll('-', '')}`,
    })
    const id = response.structuredContent.confirmationId
    // 经缓存实现本身删除（Node 目标为真实 Valkey，cacheValues 只是镜像），模拟数据密钥到期
    await adminCache.delete(confirmationKeyName(id))
    expect(await adminCache.get(confirmationKeyName(id))).toBeNull()
    expect(await confirm(admin.verified, id)).toMatchObject({
      ok: true,
      status: 'failed',
      result: { code: 'SECRET_UNAVAILABLE' },
    })
    expect(await dbSettingStore(db).find(SECRET_KEY)).toEqual(before)
    expect((await record(id))?.secretCiphertext).toBeNull()
  })

  it('确认前目标被其他管理员修改时以 STALE_TARGET 失败，保留对方的值', async () => {
    const admin = await createAdmin()
    const { token } = await issue(admin.id)
    const response = await call(token, 'settings.set', {
      key: SECRET_KEY,
      value: `111111:${newId().replaceAll('-', '')}`,
    })
    const id = response.structuredContent.confirmationId
    const theirs = `222222:${newId().replaceAll('-', '')}`
    await db
      .insert(setting)
      .values({ key: SECRET_KEY, value: theirs })
      .onConflictDoUpdate({ target: setting.key, set: { value: theirs } })
    expect(await confirm(admin.verified, id)).toMatchObject({
      ok: true,
      status: 'failed',
      result: { code: 'STALE_TARGET' },
    })
    expect(await dbSettingStore(db).find(SECRET_KEY)).toBe(theirs)
  })

  it.skipIf(!templateConfig.billing.enabled)('模型定价经确认后写入并清除模型缓存', async () => {
    const admin = await createAdmin()
    const { token } = await issue(admin.id)
    const key = `confirm-${newId()}`
    modelKeys.push(key)
    const pricing = { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 } as const
    await db.insert(aiModel).values({
      key,
      kind: 'text',
      provider: 'test',
      providerModelId: key,
      pricing,
      sort: 1_000_000,
    })
    const newPricing = { ...pricing, inputPer1k: 3 }
    const response = await call(token, 'models.update', { key, pricing: newPricing })
    const id = response.structuredContent.confirmationId
    expect(response.structuredContent.status).toBe('needs_owner_confirm')
    cacheValues.set(MODEL_CACHE_KEY, 'stale')
    expect(await confirm(admin.verified, id)).toMatchObject({
      ok: true,
      status: 'done',
      result: { key, changes: { pricing: { before: pricing, after: newPricing } } },
    })
    const [saved] = await db.select().from(aiModel).where(eq(aiModel.key, key))
    expect(saved?.pricing).toEqual(newPricing)
    expect(cacheValues.has(MODEL_CACHE_KEY)).toBe(false)
  })
})

describe.skipIf(!templateConfig.plugins['admin-mcp'] || !templateConfig.billing.enabled)(
  'refunds.review',
  () => {
    async function refundFixture(adminId: string) {
      const workspace = await createWorkspace()
      const plan = newId()
      const price = newId()
      const order = newId()
      const paid = newId()
      const requestId = newId()
      await db.$client`insert into plan(id,key,name,type,credits,features,active) values(${plan},${plan},'Fixture','credit_pack',100,'{"models":[],"maxConcurrentTasks":1,"maxSeats":1,"storageGb":1,"publicApi":false,"priorityQueue":false,"watermark":false}'::jsonb,false)`
      await db.$client`insert into plan_price(id,plan_id,provider,provider_price_id,amount,currency) values(${price},${plan},'stripe',${price},1234,'USD')`
      await db.$client`insert into purchase(id,workspace_id,user_id,plan_id,plan_price_id,provider,provider_order_id,status,amount,currency) values(${order},${workspace.id},${adminId},${plan},${price},'stripe',${order},'paid',1234,'USD')`
      await db.$client`insert into payment(id,workspace_id,provider,provider_payment_id,purchase_id,kind,amount,currency,paid_at) values(${paid},${workspace.id},'stripe',${paid},${order},'one_time',1234,'USD',now())`
      await db.$client`insert into refund_request(id,workspace_id,user_id,payment_id,reason,contact_email) values(${requestId},${workspace.id},${adminId},${paid},'Fixture refund',${`refund@${domain}`})`
      return { workspace, plan, price, requestId }
    }

    it('驳回同样经确认：确认后决策写入，审计带来源', async () => {
      const admin = await createAdmin()
      const { token, metadata } = await issue(admin.id)
      const { requestId, plan, price } = await refundFixture(admin.id)
      try {
        const approve = await call(token, 'refunds.review', {
          requestId,
          decision: 'approve',
          approvedAmount: 500,
        })
        expect(approve.structuredContent).toMatchObject({
          status: 'needs_owner_confirm',
          summary: expect.stringContaining('500 USD'),
        })
        // 一笔申请只能有一个结局：放弃通过的请求，改为驳回
        expect(
          await reject(admin.unverified, approve.structuredContent.confirmationId),
        ).toMatchObject({ ok: true })
        const response = await call(token, 'refunds.review', {
          requestId,
          decision: 'reject',
          reviewNote: 'Outside the refund policy',
        })
        const id = response.structuredContent.confirmationId
        const [unchanged] =
          await db.$client`select status from refund_request where id=${requestId}`
        expect(unchanged).toEqual({ status: 'pending' })

        expect(await confirm(admin.verified, id)).toMatchObject({
          ok: true,
          status: 'done',
          result: { refundRequestId: requestId, status: 'rejected' },
        })
        const [reviewed] = await db.$client`select status from refund_request where id=${requestId}`
        expect(reviewed).toEqual({ status: 'rejected' })
        expect(
          (await audits(admin.id)).find(({ action }) => action === 'billing.refund_rejected'),
        ).toMatchObject({
          meta: {
            via: 'mcp',
            tokenId: metadata.id,
            tool: 'refunds.review',
            confirmationId: id,
            confirmedBy: admin.id,
            stepUpMethod: 'password',
          },
        })
        expect((await call(token, 'confirmations.get', { id })).structuredContent).toMatchObject({
          status: 'done',
        })
      } finally {
        await db.$client`delete from audit_log where target_id=${requestId}`.catch(() => undefined)
        await db.$client`delete from refund_request where id=${requestId}`
        await db.$client`delete from payment where workspace_id in ${db.$client(workspaces)}`
        await db.$client`delete from purchase where workspace_id in ${db.$client(workspaces)}`
        await db.$client`delete from plan_price where id=${price}`
        await db.$client`delete from plan where id=${plan}`
      }
    })
  },
)

describe('每日清理（cleanupAdminPendingActions）', () => {
  it('到期的待确认置为过期并清空密文，删除 30 天前结束的终态记录', async () => {
    const admin = await createAdmin()
    const { metadata } = await issue(admin.id)
    const base = {
      tool: 'credits.adjust',
      action: 'credits.adjust',
      tokenId: metadata.id,
      requestedBy: admin.id,
      summary: 'fixture',
      payload: {},
      display: {},
    }
    const day = 86_400_000
    const [overdue, old, recent, live] = await db
      .insert(adminPendingAction)
      .values([
        { ...base, expiresAt: new Date(Date.now() - 1_000), secretCiphertext: new Uint8Array([1]) },
        {
          ...base,
          status: 'rejected',
          decidedAt: new Date(Date.now() - 31 * day),
          expiresAt: new Date(Date.now() - 31 * day),
        },
        {
          ...base,
          status: 'done',
          decidedAt: new Date(Date.now() - day),
          expiresAt: new Date(Date.now() - day),
        },
        { ...base, expiresAt: new Date(Date.now() + 60_000) },
      ])
      .returning({ id: adminPendingAction.id })
    const result = await cleanupAdminPendingActions(db)
    expect(result.expired).toBeGreaterThanOrEqual(1)
    expect(result.guard.tripped).toEqual([])
    expect(await record(overdue?.id ?? '')).toMatchObject({
      status: 'expired',
      secretCiphertext: null,
    })
    expect(await record(old?.id ?? '')).toBeUndefined()
    expect((await record(recent?.id ?? ''))?.status).toBe('done')
    expect((await record(live?.id ?? ''))?.status).toBe('pending')
    await db
      .delete(adminPendingAction)
      .where(and(eq(adminPendingAction.requestedBy, admin.id), sql`true`))
    await db.delete(adminApiToken).where(eq(adminApiToken.id, metadata.id))
  })
})
