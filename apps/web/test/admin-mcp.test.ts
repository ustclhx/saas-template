import { adminApiToken, user } from '@saas/db'
import type { RateLimiter } from '@saas/platform'
import { newId } from '@saas/shared'
import { eq, like } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { respondToAdminMcp } from '../../../plugins/admin-mcp/src/web/mcp.ts'
import {
  createAdminApiToken,
  listAdminApiTokens,
  revokeAdminApiToken,
} from '../../../plugins/admin-mcp/src/web/tokens.ts'
import { connectAdminMcpTestClient } from '../../../plugins/admin-mcp/test/client.ts'
import { templateConfig } from '../src/server/template-config.ts'
import { adminCache, createAdminTestDb } from './admin-test-resources.ts'

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
  return { db, handle, post, limit, createAdmin }
}

const issueToken = (db: ReturnType<typeof createAdminTestDb>, adminId: string) =>
  createAdminApiToken(db, adminId, { name: 'CLI', scopes: ['admin:read'] })

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
    await createAdminTestDb()
      .delete(user)
      .where(like(user.email, `%@${domain}`))
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
      expect((await client.listTools()).tools).toEqual([
        expect.objectContaining({ name: 'ping', annotations: { readOnlyHint: true } }),
      ])
      expect(await client.callTool({ name: 'ping', arguments: {} })).toEqual({
        content: [{ type: 'text', text: 'pong' }],
      })
      expect(await client.ping()).toEqual({})
      expect(statuses).toContain(202)
    } finally {
      await client.close()
    }
  })

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
