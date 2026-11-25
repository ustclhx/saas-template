import { MODEL_CACHE_KEY, resolveFeatureModel } from '@saas/ai'
import {
  adminApiToken,
  aiModel,
  auditLog,
  dbSettingStore,
  getSettingValue,
  type NewAiModel,
  setting,
  settingDefaults,
  user,
} from '@saas/db'
import type { RateLimiter } from '@saas/platform'
import { newId } from '@saas/shared'
import { eq, inArray, like } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { respondToAdminMcp } from '../../../plugins/admin-mcp/src/web/mcp.ts'
import {
  createAdminApiToken,
  listAdminApiTokens,
  revokeAdminApiToken,
} from '../../../plugins/admin-mcp/src/web/tokens.ts'
import { connectAdminMcpTestClient } from '../../../plugins/admin-mcp/test/client.ts'
import { templateConfig } from '../src/server/template-config.ts'
import { adminCache, cacheValues, createAdminTestDb } from './admin-test-resources.ts'

vi.mock('../../../packages/ai/src/feature-models.project.ts', () => ({
  default: {
    'admin-mcp-primary': { kind: 'text', inherit: ['admin-mcp-fallback'] },
    'admin-mcp-fallback': { kind: 'text' },
  },
}))

const dayMs = 86_400_000
const bodyLimit = 256 * 1024
const url = new URL('https://mcp.example.test/api/admin/mcp')
const domain = `${newId()}.admin-mcp-test.example`
const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })

function setup() {
  const db = createAdminTestDb()
  const limit = vi.fn<RateLimiter['limit']>().mockResolvedValue({ success: true })
  const runtime = {
    db,
    config: { APP_URL: url.origin },
    cache: adminCache,
    rateLimiter: { limit },
    requestMeta: { requestId: newId(), clientIp: null },
  }
  function handle(request: Request) {
    return respondToAdminMcp(request, () => runtime)
  }
  function post(token?: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json, text/event-stream')
    headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return handle(new Request(url, { method: 'POST', body: ping, ...init, headers }))
  }
  async function createAdmin() {
    const id = newId()
    await db.insert(user).values({ id, role: 'admin', name: 'MCP admin', email: `${id}@${domain}` })
    return id
  }
  function connect(token: string) {
    return connectAdminMcpTestClient(url, token, (input, init) => handle(new Request(input, init)))
  }
  return { db, connect, handle, post, limit, createAdmin }
}

const issueToken = (db: ReturnType<typeof createAdminTestDb>, adminId: string, write = false) =>
  createAdminApiToken(db, adminId, {
    name: 'CLI',
    scopes: write ? ['admin:read', 'admin:write'] : ['admin:read'],
  })

const actorAudits = (db: ReturnType<typeof createAdminTestDb>, actorUserId: string) =>
  db.select().from(auditLog).where(eq(auditLog.actorUserId, actorUserId)).orderBy(auditLog.id)

function expectToolError(result: unknown, code: string) {
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code } } })
}

function expectResponseHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-robots-tag')).toBe('noindex')
  expect(response.headers.has('mcp-session-id')).toBe(false)
}

async function expectUnauthorized(response: Response) {
  expect(response.status).toBe(401)
  expect(response.headers.get('www-authenticate')).toBe('Bearer')
  expectResponseHeaders(response)
  expect(await response.json()).toEqual({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Unauthorized' },
  })
}

describe.skipIf(!templateConfig.plugins['admin-mcp'])('管理员 MCP', () => {
  afterAll(async () => {
    const db = createAdminTestDb()
    const migrator = createAdminTestDb('migrator')
    const admins = await db
      .select({ id: user.id })
      .from(user)
      .where(like(user.email, `%@${domain}`))
    if (admins.length) {
      await migrator.delete(auditLog).where(
        inArray(
          auditLog.actorUserId,
          admins.map(({ id }) => id),
        ),
      )
      await db.delete(user).where(
        inArray(
          user.id,
          admins.map(({ id }) => id),
        ),
      )
    }
    await Promise.all([db.$client.end(), migrator.$client.end()])
  })

  it('用 SDK 完成 initialize、tools/list、tools/call 和协议 ping', async () => {
    const { db, handle, createAdmin } = setup()
    const adminId = await createAdmin()
    const { token } = await issueToken(db, adminId)
    const statuses: number[] = []
    const client = await connectAdminMcpTestClient(url, token, async (input, init) => {
      const response = await handle(new Request(input, init))
      expectResponseHeaders(response)
      if (response.status === 200)
        expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      statuses.push(response.status)
      return response
    })
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'admin-mcp' })
      const tools = (await client.listTools()).tools
      expect(tools.map(({ name }) => name).sort()).toEqual([
        'audit.list',
        'credits.ledger',
        'features.models',
        'metrics.summary',
        'models.list',
        'models.update',
        'orders.list',
        'ping',
        'settings.get',
        'settings.list',
        'settings.set',
        'users.get',
        'users.search',
        'workspaces.list',
      ])
      expect(tools).toContainEqual(
        expect.objectContaining({ name: 'ping', annotations: { readOnlyHint: true } }),
      )
      expect(tools.find(({ name }) => name === 'settings.get')).toMatchObject({
        inputSchema: { properties: { key: { description: expect.stringMatching(/\S/) } } },
      })
      expect(
        tools.filter((tool) => tool.annotations?.readOnlyHint === false).map(({ name }) => name),
      ).toEqual(['settings.set', 'models.update'])
      expect(await client.callTool({ name: 'ping', arguments: {} })).toEqual({
        content: [{ type: 'text', text: 'pong' }],
      })
      expect(await client.ping()).toEqual({})
      expect(statuses).toContain(202)
    } finally {
      await client.close()
    }
  })

  it('只读、scope 拒绝、输入错误和执行错误各写一条脱敏调用审计', async () => {
    const { db, connect, createAdmin } = setup()
    const adminId = await createAdmin()
    const read = await issueToken(db, adminId)
    const write = await issueToken(db, adminId, true)
    const reader = await connect(read.token)
    const writer = await connect(write.token)
    const key = 'operations.telegramBotToken'
    const secret = '123456:abcdefghijklmnopqrstuvwxyz'
    const initial = await dbSettingStore(db).find(key)
    const invalid = 'x'.repeat(201)
    try {
      expectToolError(
        await reader.callTool({ name: 'settings.set', arguments: { key, value: secret } }),
        'INSUFFICIENT_SCOPE',
      )
      expectToolError(
        await writer.callTool({
          name: 'settings.set',
          arguments: { key, value: secret, dryRun: 1 },
        }),
        'INVALID_TOOL_ARGUMENTS',
      )
      expectToolError(
        await writer.callTool({
          name: 'settings.set',
          arguments: { key: 'credits.dailyAmount', value: invalid },
        }),
        'INVALID_SETTING_VALUE',
      )
      expectToolError(
        await reader.callTool({ name: 'settings.get', arguments: { key: 'unregistered.setting' } }),
        'UNKNOWN_SETTING',
      )
      expectToolError(await reader.callTool({ name: 'unregistered.tool' }), 'UNKNOWN_TOOL')
      await reader.callTool({ name: 'settings.get', arguments: { key } })
      expect(await dbSettingStore(db).find(key)).toEqual(initial)

      const audits = await actorAudits(db, adminId)
      expect(audits.map(({ action, meta }) => ({ action, meta }))).toEqual(
        [
          [read.metadata.id, 'settings.set', { key, value: '[redacted]' }, 'INSUFFICIENT_SCOPE'],
          [
            write.metadata.id,
            'settings.set',
            { key, value: '[redacted]', dryRun: 1 },
            'INVALID_TOOL_ARGUMENTS',
          ],
          [
            write.metadata.id,
            'settings.set',
            { key: 'credits.dailyAmount', value: invalid.slice(0, 200) },
            'INVALID_SETTING_VALUE',
          ],
          [read.metadata.id, 'settings.get', { key: 'unregistered.setting' }, 'UNKNOWN_SETTING'],
          [read.metadata.id, 'unregistered.tool', {}, 'UNKNOWN_TOOL'],
          [read.metadata.id, 'settings.get', { key }, 'ok'],
        ].map(([tokenId, tool, params, result]) => ({
          action: 'admin.mcp.call',
          meta: { via: 'mcp', tokenId, tool, params, result },
        })),
      )
      expect(JSON.stringify(audits)).not.toContain(secret)
    } finally {
      await Promise.all([reader.close(), writer.close()])
    }
  })

  it('密钥设置读工具仅返回存在性，写入与预览的新旧值也脱敏', async () => {
    const { db, connect, createAdmin } = setup()
    const adminId = await createAdmin()
    const { token } = await issueToken(db, adminId, true)
    const client = await connect(token)
    const key = 'operations.telegramBotToken'
    const secret = '123456:abcdefghijklmnopqrstuvwxyz'
    const [original] = await db.select().from(setting).where(eq(setting.key, key))
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { key, ...args } })
    try {
      const changes = { oldValue: '[redacted]', newValue: '[redacted]' }
      const preview = await call('settings.set', { value: secret, dryRun: true })
      expect(preview.structuredContent).toMatchObject({ key, ...changes, dryRun: true })
      expect(await dbSettingStore(db).find(key)).toEqual(original?.value)
      const saved = await call('settings.set', { value: secret })
      expect(saved.structuredContent).toMatchObject({ key, ...changes, dryRun: false })
      expect(await dbSettingStore(db).find(key)).toBe(secret)
      const read = await call('settings.get', {})
      expect(read.structuredContent).toEqual({
        key,
        description: expect.any(String),
        secret: true,
        source: 'database',
        isSet: true,
      })
      const list = await client.callTool({ name: 'settings.list' })
      expect(list.structuredContent).toMatchObject({
        settings: expect.arrayContaining([read.structuredContent]),
      })
      const audits = await actorAudits(db, adminId)
      expect(audits).toHaveLength(4)
      expect(audits[1]).toMatchObject({
        action: 'setting.updated',
        meta: { via: 'mcp', params: { key, value: '[redacted]' }, changes, result: 'ok' },
      })
      expect(JSON.stringify({ preview, saved, read, list, audits })).not.toContain(secret)
    } finally {
      await db.delete(setting).where(eq(setting.key, key))
      if (original) await db.insert(setting).values(original)
      cacheValues.delete(`setting:${key}`)
      await client.close()
    }
  })

  it('遗留值不符合定义时读工具返回默认值并标记 fallback，不回显已存值', async () => {
    const { db, connect, createAdmin } = setup()
    const adminId = await createAdmin()
    const { token } = await issueToken(db, adminId)
    const client = await connect(token)
    const key = 'site.announcement'
    const [original] = await db.select().from(setting).where(eq(setting.key, key))
    try {
      const value = { text: 'internal fixture' }
      await db
        .insert(setting)
        .values({ key, value })
        .onConflictDoUpdate({ target: setting.key, set: { value } })
      const result = await client.callTool({ name: 'settings.get', arguments: { key } })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        key,
        value: settingDefaults[key],
        defaultValue: settingDefaults[key],
        source: 'fallback',
      })
      expect(JSON.stringify(result)).not.toContain('internal fixture')
      expect(await actorAudits(db, adminId)).toMatchObject([
        { action: 'admin.mcp.call', meta: { tool: 'settings.get', result: 'ok' } },
      ])
    } finally {
      await db.delete(setting).where(eq(setting.key, key))
      if (original) await db.insert(setting).values(original)
      await client.close()
    }
  })

  it.skipIf(!templateConfig.billing.enabled)(
    '模型定价与参数复用后台校验，通过后按更新字段审计',
    async () => {
      const { db, connect, createAdmin } = setup()
      const adminId = await createAdmin()
      const { token } = await issueToken(db, adminId, true)
      const client = await connect(token)
      const key = `mcp-${newId()}`
      const pricing = { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 } as const
      const update = (args: Record<string, unknown>) =>
        client.callTool({ name: 'models.update', arguments: { key, ...args } })
      try {
        await db.insert(aiModel).values({
          key,
          kind: 'text',
          provider: 'test',
          providerModelId: key,
          pricing,
          sort: 1_000_000,
        })
        expectToolError(
          await update({ pricing: { mode: 'per_call', credits: 1 } }),
          'MISSING_TOKEN_LIMITS',
        )
        expectToolError(
          await update({ paramsSchema: { 'x-text': { tokensPerChar: -1 } } }),
          'PARAMS_SCHEMA_INVALID',
        )
        const paramsSchema = { 'x-text': { thinking: true } }
        const newPricing = { ...pricing, inputPer1k: 2 }
        const saved = await update({ pricing: newPricing, paramsSchema })
        expect(saved.structuredContent).toMatchObject({
          key,
          changes: {
            pricing: { before: pricing, after: newPricing },
            paramsSchema: { before: null, after: paramsSchema },
          },
        })
        const list = await client.callTool({
          name: 'models.list',
          arguments: { kind: 'text', order: 'sort_desc' },
        })
        expect(list.structuredContent).toMatchObject({
          models: expect.arrayContaining([
            expect.objectContaining({ key, pricing: newPricing, paramsSchema }),
          ]),
        })
        expect(
          (await actorAudits(db, adminId)).find(({ action }) => action === 'ai.model_updated'),
        ).toMatchObject({
          meta: {
            changes: {
              pricing: { before: pricing, after: newPricing },
              paramsSchema: { before: null, after: expect.stringMatching(/^[0-9a-f]{64}$/) },
            },
            params: { key },
          },
        })
      } finally {
        await db.delete(aiModel).where(eq(aiModel.key, key))
        await client.close()
      }
    },
  )

  it.skipIf(!templateConfig.billing.enabled)(
    '设置功能模型后即时清除缓存，预览停用不落库，实际停用后立即沿用',
    async () => {
      const { db, connect, createAdmin } = setup()
      const adminId = await createAdmin()
      const { token, metadata } = await issueToken(db, adminId, true)
      const client = await connect(token)
      const feature = 'admin-mcp-primary'
      const key = `ai.model.${feature}`
      const fallbackKey = 'ai.model.admin-mcp-fallback'
      const modelKey = `mcp-${newId()}`
      const fallback = `mcp-${newId()}`
      const wrongKind = `mcp-${newId()}`
      const settingsCtx = { store: dbSettingStore(db), cache: adminCache }
      const call = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args })
      try {
        await db.insert(aiModel).values(
          [modelKey, fallback, wrongKind].map<NewAiModel>((model) => ({
            key: model,
            kind: model === wrongKind ? 'image' : 'text',
            provider: 'test',
            providerModelId: model,
            pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 },
            enabled: true,
          })),
        )
        await db.insert(setting).values({ key: fallbackKey, value: fallback })
        const inherited = { modelKey: fallback, source: 'inherited', from: 'admin-mcp-fallback' }
        expect(await resolveFeatureModel(db, settingsCtx, feature)).toEqual(inherited)
        expect((await call('settings.get', { key })).structuredContent).toMatchObject({
          key,
          source: 'default',
          defaultValue: '',
          value: '',
          resolution: inherited,
        })
        for (const value of [wrongKind, 'unregistered-model']) {
          expectToolError(await call('settings.set', { key, value }), 'INVALID_SETTING_VALUE')
        }

        const changes = { oldValue: '', newValue: modelKey }
        const preview = await call('settings.set', { key, value: modelKey, dryRun: true })
        expect(preview.structuredContent).toMatchObject({ key, ...changes, dryRun: true })
        expect(await dbSettingStore(db).find(key)).toBeUndefined()
        expect(cacheValues.has(`setting:${key}`)).toBe(true)
        const saved = await call('settings.set', { key, value: modelKey })
        expect(saved.structuredContent).toMatchObject({ key, ...changes, dryRun: false })
        expect(cacheValues.has(`setting:${key}`)).toBe(false)
        const explicit = { modelKey, source: 'explicit' }
        expect(await getSettingValue(settingsCtx, key)).toBe(modelKey)
        expect(await resolveFeatureModel(db, settingsCtx, feature)).toEqual(explicit)
        expect((await call('features.models')).structuredContent).toMatchObject({
          features: expect.arrayContaining([
            { feature, kind: 'text', inherit: ['admin-mcp-fallback'], resolution: explicit },
          ]),
        })

        cacheValues.set(MODEL_CACHE_KEY, 'unchanged')
        const modelChanges = { enabled: { before: true, after: false } }
        expect(
          (await call('models.update', { key: modelKey, enabled: false, dryRun: true }))
            .structuredContent,
        ).toMatchObject({ key: modelKey, changes: modelChanges, dryRun: true })
        expect(cacheValues.get(MODEL_CACHE_KEY)).toBe('unchanged')
        expect(await resolveFeatureModel(db, settingsCtx, feature)).toEqual(explicit)
        expect(
          (await call('models.update', { key: modelKey, enabled: false })).structuredContent,
        ).toMatchObject({ key: modelKey, changes: modelChanges, dryRun: false })
        expect(cacheValues.has(MODEL_CACHE_KEY)).toBe(false)
        expect(await resolveFeatureModel(db, settingsCtx, feature)).toEqual(inherited)
        expect((await call('settings.get', { key })).structuredContent).toMatchObject({
          key,
          source: 'database',
          value: modelKey,
          resolution: inherited,
        })
        const audits = await actorAudits(db, adminId)
        expect(audits.filter(({ action }) => action !== 'admin.mcp.call')).toMatchObject([
          {
            action: 'setting.updated',
            targetId: key,
            meta: { via: 'mcp', tokenId: metadata.id, tool: 'settings.set', changes, result: 'ok' },
          },
          {
            action: 'ai.model_disabled',
            meta: {
              via: 'mcp',
              tokenId: metadata.id,
              tool: 'models.update',
              changes: modelChanges,
              result: 'ok',
            },
          },
        ])
        expect(
          audits.filter(
            ({ meta }) =>
              meta && typeof meta === 'object' && 'dryRun' in meta && meta.dryRun === true,
          ),
        ).toMatchObject([
          { action: 'admin.mcp.call', meta: { tool: 'settings.set', result: 'ok' } },
          { action: 'admin.mcp.call', meta: { tool: 'models.update', result: 'ok' } },
        ])
      } finally {
        await db.delete(setting).where(inArray(setting.key, [key, fallbackKey]))
        await db.delete(aiModel).where(inArray(aiModel.key, [modelKey, fallback, wrongKind]))
        cacheValues.delete(`setting:${key}`)
        cacheValues.delete(`setting:${fallbackKey}`)
        cacheValues.delete(MODEL_CACHE_KEY)
        await client.close()
      }
    },
  )

  it('创建显示明文一次，列表只返回元数据，其他管理员无法吊销', async () => {
    const { db, createAdmin } = setup()
    const adminId = await createAdmin()
    const otherAdmin = await createAdmin()
    const { token, metadata } = await issueToken(db, adminId)
    expect(token).toMatch(/^xat_[A-Za-z0-9_-]{43}$/)
    expect(metadata.prefix).toBe(token.slice(0, 12))
    const [stored] = await db.select().from(adminApiToken).where(eq(adminApiToken.id, metadata.id))
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await listAdminApiTokens(db, adminId)).toEqual([metadata])
    expect(metadata).not.toHaveProperty('tokenHash')
    expect(await listAdminApiTokens(db, otherAdmin)).toEqual([])
    expect(await db.transaction((tx) => revokeAdminApiToken(tx, otherAdmin, metadata.id))).toBe(
      false,
    )
  })

  it('在个人列表保留 30 天内失效的令牌，隐藏更旧记录且保留数据行', async () => {
    const { db, createAdmin } = setup()
    const adminId = await createAdmin()
    const now = Date.now()
    const recent = new Date(now - 29 * dayMs)
    const old = new Date(now - 31 * dayMs)
    const entries = [
      { name: 'active', expiresAt: new Date(now + dayMs) },
      { name: 'recently expired', expiresAt: recent },
      { name: 'old expiration', expiresAt: old },
      { name: 'recently revoked', expiresAt: new Date(now + dayMs), revokedAt: recent },
      { name: 'old revocation', expiresAt: new Date(now + dayMs), revokedAt: old },
    ]
    await db.insert(adminApiToken).values(
      entries.map((entry) => ({
        ...entry,
        userId: adminId,
        prefix: 'xat_fixture0',
        tokenHash: newId().replaceAll('-', '').repeat(2),
        scopes: ['admin:read'],
      })),
    )
    const list = await listAdminApiTokens(db, adminId)
    expect(list.map(({ name }) => name).sort()).toEqual([
      'active',
      'recently expired',
      'recently revoked',
    ])
    expect(list.find(({ name }) => name === 'recently revoked')?.revokedAt).toEqual(recent)
    expect(
      await db.select().from(adminApiToken).where(eq(adminApiToken.userId, adminId)),
    ).toHaveLength(entries.length)
  })

  it('拒绝缺失及无法匹配的令牌，不调用限流器', async () => {
    const { post, limit } = setup()
    await expectUnauthorized(await post())
    await expectUnauthorized(await post(`xat_${'A'.repeat(43)}`))
    expect(limit).not.toHaveBeenCalled()
  })

  it.each(['过期', '吊销', '降级', '封禁'] as const)('立即拒绝%s后的令牌', async (state) => {
    const { db, post, createAdmin } = setup()
    const adminId = await createAdmin()
    const { token, metadata } = await issueToken(db, adminId)
    expect((await post(token)).status).toBe(200)
    switch (state) {
      case '过期':
        await db
          .update(adminApiToken)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(adminApiToken.id, metadata.id))
        break
      case '吊销':
        expect(await db.transaction((tx) => revokeAdminApiToken(tx, adminId, metadata.id))).toBe(
          true,
        )
        break
      case '降级':
        await db.update(user).set({ role: 'user' }).where(eq(user.id, adminId))
        break
      case '封禁':
        await db.update(user).set({ banned: true }).where(eq(user.id, adminId))
        break
    }
    await expectUnauthorized(await post(token))
  })

  it('最多每分钟更新一次最近使用时间', async () => {
    const { db, post, createAdmin } = setup()
    const adminId = await createAdmin()
    const { token } = await issueToken(db, adminId)
    expect((await post(token)).status).toBe(200)
    const [firstUse] = await listAdminApiTokens(db, adminId)
    expect(firstUse?.lastUsedAt).toBeInstanceOf(Date)
    expect((await post(token)).status).toBe(200)
    const [secondUse] = await listAdminApiTokens(db, adminId)
    expect(secondUse?.lastUsedAt).toEqual(firstUse?.lastUsedAt)
  })

  it('以令牌 ID 限流，超限请求返回 429', async () => {
    const { db, post, limit, createAdmin } = setup()
    const adminId = await createAdmin()
    const { token, metadata } = await issueToken(db, adminId)
    limit.mockResolvedValueOnce({ success: false })
    const response = await post(token)
    expect(limit).toHaveBeenCalledExactlyOnceWith('admin-mcp', metadata.id)
    expect(response.status).toBe(429)
    expectResponseHeaders(response)
    const [unused] = await listAdminApiTokens(db, adminId)
    expect(unused?.lastUsedAt).toBeNull()
  })

  it('按声明长度和实际流长度拒绝超过 256 KiB 的请求', async () => {
    const { db, post, createAdmin } = setup()
    const { token } = await issueToken(db, await createAdmin())
    const declared = await post(token, {
      headers: { 'Content-Length': String(bodyLimit + 1) },
    })
    expect(declared.status).toBe(413)
    expectResponseHeaders(declared)

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bodyLimit))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    const init = { body, duplex: 'half' as const }
    const streamed = await post(token, init)
    expect(streamed.status).toBe(413)
    expectResponseHeaders(streamed)
  })

  it.each(['GET', 'DELETE'])('%s 返回 405 且声明 Allow', async (method) => {
    const response = await setup().handle(new Request(url, { method }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expectResponseHeaders(response)
  })

  it('拒绝用请求 Host 冒充允许来源的浏览器 POST', async () => {
    const response = await setup().handle(
      new Request('https://other.test/api/admin/mcp', {
        method: 'POST',
        headers: { Origin: 'https://other.test' },
      }),
    )
    expect(response.status).toBe(403)
    expectResponseHeaders(response)
  })

  it('基础设施错误映射为安全的 JSON-RPC 错误', async () => {
    const { db, post, limit, createAdmin } = setup()
    const { token } = await issueToken(db, await createAdmin())
    limit.mockRejectedValueOnce(new Error('internal connection details'))
    const response = await post(token)
    expect(response.status).toBe(500)
    expectResponseHeaders(response)
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal server error' },
    })
  })
})
