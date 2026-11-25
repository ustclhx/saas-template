import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type AdminToolContext, defineAdminTool } from './define.ts'

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }))

vi.mock(import('@web/features/admin/action.ts'), async (importOriginal) => ({
  ...(await importOriginal()),
  runAdminAction: vi.fn(async (_ctx, _name, handler) => handler({ audit })),
}))

it('只读令牌调用写工具时，拒绝执行并以所属管理员记录脱敏审计', async () => {
  const ctx: AdminToolContext = {
    db: {} as AdminToolContext['db'],
    admin: { id: 'admin-id' },
    token: { id: 'token-id', scopes: ['admin:read'] },
    cache: {} as AdminToolContext['cache'],
    requestMetadata: { clientIp: null, requestId: 'request-id' },
    workersAiAvailable: false,
    aiFaultInjectionEnabled: false,
  }
  const run = vi.fn()
  const tool = defineAdminTool({
    name: 'settings.set',
    scope: 'admin:write',
    description: 'Save a setting',
    input: z.object({ key: z.string(), value: z.unknown() }),
    run,
  }).register(ctx)

  const key = 'operations.telegramBotToken'
  expect(await tool.call({ key, value: { secret: 'fixture' } })).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } },
  })
  expect(run).not.toHaveBeenCalled()
  expect(audit).toHaveBeenCalledExactlyOnceWith({
    action: 'admin.mcp.call',
    targetType: 'admin_api_token',
    targetId: 'token-id',
    meta: {
      via: 'mcp',
      tokenId: 'token-id',
      tool: 'settings.set',
      params: { key, value: '[redacted]' },
      result: 'INSUFFICIENT_SCOPE',
    },
  })
})
