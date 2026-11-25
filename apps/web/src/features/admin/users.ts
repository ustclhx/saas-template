import { account, type Database, member, organization, user } from '@saas/db'
import { AppError } from '@saas/shared'
import { desc, eq, ilike, or, sql } from 'drizzle-orm'
import { ADMIN_PAGE_SIZE, adminListSearch } from './list.ts'

const userListFields = {
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  banned: user.banned,
}

export async function listAdminUsers(
  db: Database,
  input: { offset?: number; limit?: number; q?: string | undefined },
) {
  const { offset, q } = adminListSearch(['q'])(input)
  const limit = input.limit ?? ADMIN_PAGE_SIZE
  const where = q
    ? or(
        ilike(user.email, `%${q}%`),
        ilike(user.name, `%${q}%`),
        ilike(sql`${user.id}::text`, `%${q}%`),
      )
    : undefined
  const rows = await db
    .select(userListFields)
    .from(user)
    .where(where)
    .orderBy(desc(user.createdAt), desc(user.id))
    .offset(offset)
    .limit(limit + 1)
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
}

export async function adminUserDetail(db: Database, id: string) {
  const [target] = await db
    .select({
      ...userListFields,
      createdAt: user.createdAt,
      banReason: user.banReason,
      banExpires: user.banExpires,
    })
    .from(user)
    .where(eq(user.id, id))
  if (!target) throw new AppError('NOT_FOUND', 'User not found', { status: 404 })
  const workspaces = await db
    .select({
      id: organization.id,
      name: organization.name,
      role: member.role,
    })
    // biome-ignore lint/plugin: 平台管理员按用户查询其所属的全部空间。
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, id))
  const methods = await db
    .select({ provider: account.providerId })
    .from(account)
    .where(eq(account.userId, id))
  return { user: target, workspaces, methods: [...new Set(methods.map((m) => m.provider))] }
}
