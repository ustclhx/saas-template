import { Buffer } from 'node:buffer'
import { adminApiToken, type Database, user } from '@saas/db'
import { AppError } from '@saas/shared'
import { type AdminTransaction, isActiveAdmin } from '@web/features/admin/action.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { and, desc, eq, gt, gte, isNull, lte, or } from 'drizzle-orm'
import { z } from 'zod'
import { adminMcpConfigSchema } from '../config.ts'
import { TOKEN_NAME_MAX } from './api-tokens.ts'

const DAY_MS = 86_400_000
const TOUCH_INTERVAL_MS = 60_000
const tokenPattern = /^xat_[A-Za-z0-9_-]{43}$/
const tokenScopes = z
  .array(z.enum(['admin:read', 'admin:write']))
  .refine((scopes) => scopes.includes('admin:read') && new Set(scopes).size === scopes.length)

export type AdminTokenScope = z.output<typeof tokenScopes>[number]

const tokenInput = z.object({
  name: z.string().trim().min(1).max(TOKEN_NAME_MAX),
  scopes: tokenScopes,
  expiresAt: z.date().optional(),
})

// 创建与列表只返回可展示的列。哈希仅供鉴权查询。
const tokenMetadata = {
  id: adminApiToken.id,
  name: adminApiToken.name,
  prefix: adminApiToken.prefix,
  scopes: adminApiToken.scopes,
  expiresAt: adminApiToken.expiresAt,
  lastUsedAt: adminApiToken.lastUsedAt,
  revokedAt: adminApiToken.revokedAt,
  createdAt: adminApiToken.createdAt,
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Buffer.from(digest).toString('hex')
}

/** adminId 取自 runAdminAction 的实时管理员上下文，调用方在同一事务写审计。 */
export async function createAdminApiToken(
  db: Pick<AdminTransaction, 'insert'>,
  adminId: string,
  input: z.input<typeof tokenInput>,
) {
  const parsed = tokenInput.safeParse(input)
  if (!parsed.success)
    throw new AppError('ADMIN_API_TOKEN_INVALID', 'Invalid token name, scopes or expiration')

  const now = Date.now()
  const { maxTokenDays } = adminMcpConfigSchema.parse(templateConfig.plugins['admin-mcp'] ?? {})
  const expiresAt = parsed.data.expiresAt ?? new Date(now + Math.min(90, maxTokenDays) * DAY_MS)
  if (expiresAt.getTime() <= now || expiresAt.getTime() > now + maxTokenDays * DAY_MS)
    throw new AppError('ADMIN_API_TOKEN_INVALID', 'Token expiration is outside the allowed range')

  const token = `xat_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
  const [metadata] = await db
    .insert(adminApiToken)
    .values({
      userId: adminId,
      name: parsed.data.name,
      prefix: token.slice(0, 12),
      tokenHash: await hashToken(token),
      scopes: parsed.data.scopes,
      expiresAt,
    })
    .returning(tokenMetadata)
  if (!metadata) throw new Error('Admin API token insert returned no row')
  return { token, metadata }
}

export function listAdminApiTokens(db: Database, adminId: string) {
  const cutoff = new Date(Date.now() - 30 * DAY_MS)
  return db
    .select(tokenMetadata)
    .from(adminApiToken)
    .where(
      and(
        eq(adminApiToken.userId, adminId),
        gte(adminApiToken.expiresAt, cutoff),
        or(isNull(adminApiToken.revokedAt), gte(adminApiToken.revokedAt, cutoff)),
      ),
    )
    .orderBy(desc(adminApiToken.createdAt), desc(adminApiToken.id))
}

/** 仅本人可吊销，重复吊销不覆盖原时间。调用方在同一事务写审计。 */
export async function revokeAdminApiToken(db: AdminTransaction, adminId: string, tokenId: string) {
  const [revoked] = await db
    .update(adminApiToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(adminApiToken.id, tokenId),
        eq(adminApiToken.userId, adminId),
        isNull(adminApiToken.revokedAt),
      ),
    )
    .returning({ id: adminApiToken.id })
  return revoked !== undefined
}

export async function verifyAdminApiToken(db: Database, token: string) {
  if (!tokenPattern.test(token)) return null
  const [row] = await db
    .select({
      id: adminApiToken.id,
      scopes: adminApiToken.scopes,
      lastUsedAt: adminApiToken.lastUsedAt,
      admin: { id: user.id, role: user.role, banned: user.banned, banExpires: user.banExpires },
    })
    .from(adminApiToken)
    .innerJoin(user, eq(adminApiToken.userId, user.id))
    .where(
      and(
        eq(adminApiToken.tokenHash, await hashToken(token)),
        isNull(adminApiToken.revokedAt),
        gt(adminApiToken.expiresAt, new Date()),
      ),
    )
  if (!row || !isActiveAdmin(row.admin)) return null
  const scopes = tokenScopes.safeParse(row.scopes)
  if (!scopes.success) return null
  return { id: row.id, adminId: row.admin.id, scopes: scopes.data, lastUsedAt: row.lastUsedAt }
}

export async function markAdminApiTokenUsed(
  db: Database,
  token: { id: string; lastUsedAt: Date | null },
) {
  const now = new Date()
  const cutoff = new Date(now.getTime() - TOUCH_INTERVAL_MS)
  if (token.lastUsedAt && token.lastUsedAt > cutoff) return

  // 并发请求可能都读到旧时间，由 UPDATE 条件保证只写一次。
  await db
    .update(adminApiToken)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(adminApiToken.id, token.id),
        or(isNull(adminApiToken.lastUsedAt), lte(adminApiToken.lastUsedAt, cutoff)),
      ),
    )
}
