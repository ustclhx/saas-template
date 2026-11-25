import { expect, it, vi } from 'vitest'
import { createAdminApiToken } from './tokens.ts'

vi.mock('@web/server/template-config.ts', () => ({
  templateConfig: { plugins: { 'admin-mcp': { maxTokenDays: 30 } } },
}))

const day = 86_400_000

it.each([
  { scopes: ['admin:write'] as const },
  { scopes: ['admin:read', 'admin:read'] as const },
  { expiresAt: new Date(Date.now() - day) },
  { expiresAt: new Date(Date.now() + 31 * day) },
])('拒绝不符合令牌 scope 或有效期限制的创建输入 %#', async (invalid) => {
  const db = { insert: vi.fn() }
  await expect(
    createAdminApiToken(db, 'admin-id', {
      name: 'MCP',
      scopes: [...(invalid.scopes ?? ['admin:read'])],
      expiresAt: invalid.expiresAt,
    }),
  ).rejects.toMatchObject({ code: 'ADMIN_API_TOKEN_INVALID' })
  expect(db.insert).not.toHaveBeenCalled()
})
