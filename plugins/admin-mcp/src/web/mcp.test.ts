import { describe, expect, it, vi } from 'vitest'
import { respondToAdminMcp } from './mcp.ts'

type McpRuntime = ReturnType<Parameters<typeof respondToAdminMcp>[1]>

describe('admin MCP 端点的插件可用性（public-site-availability）', () => {
  it('RL_ADMIN_MCP 缺失（插件标为不可用）时返回 503，不读取令牌与数据库', async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('db must not be used')
        },
      },
    )
    const limit = vi.fn()
    const response = await respondToAdminMcp(
      new Request('https://example.test/api/admin/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      }),
      () =>
        ({
          db,
          rateLimiter: { limit },
          pluginStatus: { 'admin-mcp': 'unavailable' },
          config: { APP_URL: 'https://example.test' },
        }) as unknown as McpRuntime,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { message: 'Service unavailable' } })
    expect(limit).not.toHaveBeenCalled()
  })

  it('其他插件不可用不影响本端点（无令牌仍按 401 处理）', async () => {
    const response = await respondToAdminMcp(
      new Request('https://example.test/api/admin/mcp', { method: 'POST' }),
      () =>
        ({
          pluginStatus: { 'admin-mcp': 'up', agents: 'unavailable' },
          config: { APP_URL: 'https://example.test' },
        }) as unknown as McpRuntime,
    )
    expect(response.status).toBe(401)
  })
})
