import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type AdminToolContext, defineAdminTool } from './define.ts'

const { audit, createPendingAction } = vi.hoisted(() => ({
  audit: vi.fn(),
  createPendingAction: vi.fn(),
}))

vi.mock(import('@web/features/admin/action.ts'), async (importOriginal) => ({
  ...(await importOriginal()),
  runAdminAction: vi.fn(async (_ctx, _name, handler) => handler({ audit })),
}))
vi.mock(import('@web/features/admin/confirmations/service.ts'), async (importOriginal) => ({
  ...(await importOriginal()),
  createPendingAction,
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
    appUrl: 'https://admin.example.test',
  }
  const run = vi.fn()
  const tool = defineAdminTool({
    name: 'settings.set',
    scope: 'admin:write',
    description: 'Save a registered runtime setting.',
    input: z.object({ key: z.string(), value: z.unknown() }),
    params: { key: 'Registered setting key.', value: 'New value for the setting.' },
    adminAction: ({ key, value }) => ({
      name: 'setting.update',
      input: { entries: [[key, value]] },
    }),
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

describe('需要管理员确认的写工具', () => {
  const ctx: AdminToolContext = {
    db: {} as AdminToolContext['db'],
    admin: { id: 'admin-id' },
    token: { id: 'token-id', scopes: ['admin:read', 'admin:write'] },
    cache: {} as AdminToolContext['cache'],
    requestMetadata: { clientIp: null, requestId: 'request-id' },
    workersAiAvailable: false,
    aiFaultInjectionEnabled: false,
    appUrl: 'https://admin.example.test',
  }
  const run = vi.fn(async () => ({ structuredContent: { preview: true }, content: [] }))
  const confirm = vi.fn(async () => ({ summary: 'Grant 1', display: {}, payload: {} }))
  const tool = defineAdminTool({
    name: 'credits.adjust',
    scope: 'admin:write',
    description: 'Request a credit adjustment for a workspace.',
    input: z.strictObject({ amount: z.number(), dryRun: z.boolean().optional() }),
    params: { amount: 'Credits to grant.', dryRun: 'Preview only.' },
    adminAction: () => 'credits.adjust',
    run,
    confirm,
    execute: () => ({ kind: 'transaction', run: async () => ({}) }),
  }).register(ctx)

  beforeEach(() => {
    vi.clearAllMocks()
    createPendingAction.mockResolvedValue({
      id: 'confirmation-id',
      summary: 'Grant 1',
      expiresAt: new Date('2026-11-25T00:30:00.000Z'),
    })
  })

  it('AI 附加 confirmed 等字段时拒绝调用，不执行也不创建记录', async () => {
    for (const forged of [{ confirmed: true }, { confirmation: { id: 'x' } }]) {
      expect(await tool.call({ amount: 1, ...forged })).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INVALID_TOOL_ARGUMENTS' } },
      })
    }
    expect(run).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(createPendingAction).not.toHaveBeenCalled()
  })

  it('dryRun 只预览，不创建待确认记录', async () => {
    expect(await tool.call({ amount: 1, dryRun: true })).toMatchObject({
      structuredContent: { preview: true },
    })
    expect(run).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()
    expect(createPendingAction).not.toHaveBeenCalled()
  })

  it('正式调用不执行业务，改为创建待确认记录并返回确认链接', async () => {
    expect(await tool.call({ amount: 1 })).toMatchObject({
      structuredContent: {
        status: 'needs_owner_confirm',
        confirmationId: 'confirmation-id',
        confirmUrl: 'https://admin.example.test/admin/confirm/confirmation-id',
        expiresAt: '2026-11-25T00:30:00.000Z',
        summary: 'Grant 1',
      },
    })
    expect(run).not.toHaveBeenCalled()
    expect(createPendingAction).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        tool: 'credits.adjust',
        action: 'credits.adjust',
        tokenId: 'token-id',
      }),
    )
  })
})
