import { account, auditLog, member, metricsDaily, organization, user } from '@saas/db'
import { newId } from '@saas/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { respondToAdminMcp } from '../../../plugins/admin-mcp/src/web/mcp.ts'
import { createAdminApiToken } from '../../../plugins/admin-mcp/src/web/tokens.ts'
import { connectAdminMcpTestClient } from '../../../plugins/admin-mcp/test/client.ts'
import { listAuditLogs } from '../src/features/admin/audit.ts'
import { readAdminMetrics } from '../src/features/admin/metrics.ts'
import { adminUserDetail, listAdminUsers } from '../src/features/admin/users.ts'
import {
  getAdminWorkspaceCreditLedger,
  listAdminWorkspaces,
} from '../src/features/admin/workspaces.ts'
import { listAdminPurchases } from '../src/features/billing/admin-data.ts'
import { templateConfig } from '../src/server/template-config.ts'
import { adminCache, createAdminTestDb } from './admin-test-resources.ts'

const fixture = newId()
const adminId = newId()
const userId = newId()
const active = newId()
const deleted = newId()
const planId = newId()
const priceId = newId()
const date = '2066-11-25'
const at = new Date(`${date}T12:00:00Z`)
const userEmail = `${userId}@${fixture}.test`
const url = new URL('https://mcp.example.test/api/admin/mcp')

describe.skipIf(!templateConfig.plugins['admin-mcp'])('管理员 MCP 只读业务工具', () => {
  const db = createAdminTestDb()
  let client: Awaited<ReturnType<typeof connectAdminMcpTestClient>>
  let insertedMetrics = false

  beforeAll(async () => {
    await db.transaction(async (tx) => {
      await tx.insert(user).values([
        { id: adminId, email: `${adminId}@${fixture}.test`, name: fixture, role: 'admin' },
        { id: userId, email: userEmail, name: fixture, twoFactorEnabled: true },
      ])
      await tx.insert(organization).values([
        { id: active, name: fixture, slug: active, metadata: 'hidden workspace metadata' },
        { id: deleted, name: fixture, slug: deleted, deletedAt: at },
      ])
      await tx.insert(member).values([
        { id: newId(), userId, organizationId: active, role: 'owner' },
        { id: newId(), userId, organizationId: deleted, role: 'member' },
      ])
      await tx.insert(account).values({
        id: newId(),
        userId,
        providerId: 'google',
        accountId: fixture,
        accessToken: 'hidden account token',
      })
      await tx.insert(auditLog).values([
        {
          actorUserId: userId,
          workspaceId: active,
          action: fixture,
          createdAt: at,
          meta: { detail: 'visible' },
        },
        {
          actorUserId: userId,
          workspaceId: deleted,
          action: fixture,
          targetType: 'setting',
          targetId: 'operations.discordWebhookUrl',
          createdAt: at,
          meta: {
            oldValue: 'legacy secret',
            newValue: 'legacy secret',
            tokenHash: 'hidden token hash',
            detail: 'visible',
          },
        },
      ])
    })
    const [metric] = await db
      .insert(metricsDaily)
      .values({
        day: date,
        registrations: 2,
        totalUsers: 12,
        totalWorkspaces: 6,
        paidWorkspaces: 2,
        mrrByCurrency: { USD: 3000 },
        creditsConsumed: 100,
        overageAbsorbed: 20,
        overageByModel: { fixture: 20 },
        textCompleted: 8,
        textFailed: 2,
        textAborted: 0,
        dataThrough: at,
      })
      .onConflictDoNothing()
      .returning({ day: metricsDaily.day })
    insertedMetrics = metric !== undefined
    expect(insertedMetrics).toBe(true)
    const { token } = await createAdminApiToken(db, adminId, {
      name: fixture,
      scopes: ['admin:read'],
    })
    const runtime = {
      db,
      config: { APP_URL: url.origin },
      cache: adminCache,
      rateLimiter: { limit: async () => ({ success: true }) },
      requestMeta: { requestId: fixture, clientIp: null },
      ai: { available: false as const },
    }
    client = await connectAdminMcpTestClient(url, token, (input, init) =>
      respondToAdminMcp(new Request(input, init), () => runtime),
    )
  })

  afterAll(async () => {
    await client?.close()
    const migrator = createAdminTestDb('migrator')
    await migrator.delete(auditLog).where(inArray(auditLog.actorUserId, [adminId, userId]))
    if (insertedMetrics) await migrator.delete(metricsDaily).where(eq(metricsDaily.day, date))
    const sql = db.$client
    await sql`delete from credit_ledger where workspace_id in (${active}, ${deleted})`
    await sql`delete from purchase where workspace_id in (${active}, ${deleted})`
    await sql`delete from plan_price where id=${priceId}`
    await sql`delete from plan where id=${planId}`
    await db.delete(member).where(eq(member.userId, userId))
    await db.delete(account).where(eq(account.userId, userId))
    await db.delete(organization).where(inArray(organization.id, [active, deleted]))
    await db.delete(user).where(inArray(user.id, [adminId, userId]))
    await Promise.all([db.$client.end(), migrator.$client.end()])
  })

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBeFalsy()
    return result.structuredContent
  }

  it('复用用户与空间查找、投影和分页，公开工具的页大小上限为 50', async () => {
    const result = await call('users.search', { q: fixture, limit: 1, offset: 1 })
    expect(result).toEqual(await listAdminUsers(db, { q: fixture, limit: 1, offset: 1 }))
    expect(result).toEqual({
      rows: [
        {
          id: adminId,
          email: `${adminId}@${fixture}.test`,
          name: fixture,
          role: 'admin',
          banned: false,
        },
      ],
      hasMore: false,
    })
    const detail = await call('users.get', { id: userId })
    expect(detail).toEqual(JSON.parse(JSON.stringify(await adminUserDetail(db, userId))))
    expect(detail).toMatchObject({
      methods: ['google'],
      workspaces: expect.arrayContaining([
        { id: active, name: fixture, role: 'owner' },
        { id: deleted, name: fixture, role: 'member' },
      ]),
    })
    expect(detail).not.toHaveProperty('user.twoFactorEnabled')
    const spaces = await call('workspaces.list', { q: fixture, status: 'deleted' })
    expect(spaces).toEqual(
      JSON.parse(JSON.stringify(await listAdminWorkspaces(db, { q: fixture, status: 'deleted' }))),
    )
    expect(spaces).toEqual({
      rows: [
        {
          id: deleted,
          name: fixture,
          slug: deleted,
          isPersonal: false,
          deletedAt: at.toISOString(),
        },
      ],
      hasMore: false,
    })
    expect(await client.callTool({ name: 'users.search', arguments: { limit: 51 } })).toMatchObject(
      { isError: true },
    )
  })

  it.skipIf(!templateConfig.billing.enabled || !templateConfig.credits.enabled)(
    '订单过滤与流水分页先按空间隔离，再返回后台投影',
    async () => {
      const sql = db.$client
      // 使用独立套餐避免依赖种子数据，订单原始载荷与流水备注仅用于检验投影。
      await sql`insert into plan(id,key,name,type,credits,features) values(${planId},${fixture},'MCP fixture','credit_pack',5,'{"models":[],"maxConcurrentTasks":1,"maxSeats":1,"storageGb":1,"publicApi":false,"priorityQueue":false,"watermark":false}'::jsonb)`
      await sql`insert into plan_price(id,plan_id,provider,provider_price_id,amount,currency) values(${priceId},${planId},'stripe',${fixture},500,'USD')`
      for (const workspaceId of [active, deleted]) {
        await sql`insert into purchase(id,workspace_id,user_id,plan_id,plan_price_id,provider,provider_order_id,status,amount,currency,raw,created_at)
        values(${newId()},${workspaceId},${userId},${planId},${priceId},'stripe',${workspaceId},'paid',500,'USD','{"private":true}'::jsonb,${at.toISOString()})`
      }
      for (const [workspaceId, delta] of [
        [active, 1],
        [active, 2],
        [deleted, 3],
      ] as const) {
        await sql`insert into credit_ledger(id,workspace_id,type,delta,note,created_at)
        values(${newId()},${workspaceId},'grant',${delta},'internal note',${at.toISOString()})`
      }
      const orders = await call('orders.list', { workspaceId: deleted })
      expect(orders).toEqual(await listAdminPurchases(db, { workspaceId: deleted, offset: 0 }))
      expect(orders).toMatchObject({
        rows: [{ workspaceId: deleted, amount: 500 }],
        hasMore: false,
      })
      const allOrders = await call('orders.list', { limit: 2 })
      expect(allOrders).toEqual(await listAdminPurchases(db, { offset: 0, limit: 2 }))
      expect(allOrders).toMatchObject({
        rows: expect.arrayContaining([
          expect.objectContaining({ workspaceId: active }),
          expect.objectContaining({ workspaceId: deleted }),
        ]),
      })
      const first = await call('credits.ledger', { workspaceId: active, limit: 1 })
      const second = await call('credits.ledger', { workspaceId: active, limit: 1, offset: 1 })
      const page = await getAdminWorkspaceCreditLedger(db, active)
      const [latest, oldest] = JSON.parse(JSON.stringify(page.items))
      expect(first).toEqual({ rows: [latest], hasMore: true })
      expect(second).toEqual({ rows: [oldest], hasMore: false })
      expect(oldest).toEqual({
        id: expect.any(String),
        createdAt: at.toISOString(),
        type: 'grant',
        delta: 1,
      })
    },
  )

  it('审计匹配后台筛选并遮蔽旧记录的密钥，指标只返回看板聚合', async () => {
    const filter = { actor: userEmail, action: fixture, from: date, to: date, offset: 0 }
    const safe = await call('audit.list', { ...filter, workspaceId: active })
    expect(safe).toEqual(
      JSON.parse(JSON.stringify(await listAuditLogs(db, { ...filter, workspaceId: active }))),
    )
    const audits = await call('audit.list', filter)
    expect(audits).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ log: expect.objectContaining({ workspaceId: active }) }),
        expect.objectContaining({
          log: expect.objectContaining({
            workspaceId: deleted,
            meta: {
              oldValue: '[REDACTED]',
              newValue: '[REDACTED]',
              tokenHash: '[REDACTED]',
              detail: 'visible',
            },
          }),
        }),
      ]),
      hasMore: false,
    })
    const metrics = await call('metrics.summary', { from: date, to: date })
    const { rows, latest, ...summary } = await readAdminMetrics(db, { from: date, to: date })
    expect(metrics).toEqual({
      ...summary,
      dayCount: rows.length,
      latest: {
        paidWorkspaces: 2,
        mrrByCurrency: { USD: 3000 },
        dataThrough: at.toISOString(),
        computedAt: latest?.computedAt.toISOString(),
      },
    })
  })
})
