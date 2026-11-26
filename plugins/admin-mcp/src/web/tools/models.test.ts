import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminToolContext } from './define.ts'
import { modelTools } from './models.ts'

const { audit, listAdminModels, updateAdminModelByKey } = vi.hoisted(() => ({
  audit: vi.fn(),
  listAdminModels: vi.fn(),
  updateAdminModelByKey: vi.fn(),
}))

vi.mock(import('@web/features/admin/action.ts'), async (importOriginal) => ({
  ...(await importOriginal()),
  runAdminAction: vi.fn(async (_ctx, _name, handler) => handler({ audit })),
}))
vi.mock(import('@web/features/ai/admin-models.ts'), () => ({
  listAdminModels,
  updateAdminModelByKey,
}))
vi.mock(import('@web/server/feature-gates.ts'), () => ({ requireFeature: vi.fn() }))

const context: AdminToolContext = {
  db: {
    select: () => ({
      from: () => ({ where: async () => [{ pricing: { mode: 'per_call', credits: 1 } }] }),
    }),
  } as unknown as AdminToolContext['db'],
  admin: { id: 'admin-id' },
  token: { id: 'token-id', scopes: ['admin:read', 'admin:write'] },
  cache: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  requestMetadata: { clientIp: null, requestId: 'request-id' },
  workersAiAvailable: false,
  aiFaultInjectionEnabled: false,
  appUrl: 'https://admin.example.test',
}

const [listTool, updateTool] = modelTools
const list = listTool.register(context)
const update = updateTool.register(context)

describe('模型 MCP 工具的显示名', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateAdminModelByKey.mockResolvedValue({ changes: {} })
  })

  it('目录返回已配置的显示名和未配置的 null', async () => {
    const models = [
      { key: 'flux', displayName: 'FLUX 快速' },
      { key: 'veo', displayName: null },
    ]
    listAdminModels.mockResolvedValue({ models, hasMore: false })
    expect(await list.call({})).toMatchObject({ structuredContent: { models } })
  })

  it('允许单独修改显示名，去掉首尾空白后验证最多 60 个字符', async () => {
    const displayName = '名'.repeat(60)
    expect(await update.call({ key: 'flux', displayName: `  ${displayName}  ` })).toMatchObject({
      structuredContent: { changes: {} },
    })
    expect(updateAdminModelByKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'flux', displayName }),
      expect.anything(),
      false,
    )
    expect(await update.call({ key: 'flux', displayName: '名'.repeat(61) })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_TOOL_ARGUMENTS' } },
    })
    expect(updateAdminModelByKey).toHaveBeenCalledOnce()
  })

  it.each([null, ''])('转发明确清空的显示名 %j', async (displayName) => {
    await update.call({ key: 'flux', displayName })
    expect(updateAdminModelByKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'flux', displayName }),
      expect.anything(),
      false,
    )
  })

  it('传入其他字段时保留省略的显示名', async () => {
    await update.call({ key: 'flux', enabled: false })
    expect(updateAdminModelByKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'flux', displayName: undefined, enabled: false }),
      expect.anything(),
      false,
    )
  })
})
