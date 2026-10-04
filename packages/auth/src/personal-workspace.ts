import { type Database, member, type Organization, organization, scoped } from '@saas/db'
import { newId } from '@saas/shared'
import type { BetterAuthOptions } from 'better-auth'

/**
 * 个人空间（design.md 决策 4、5，specs/workspace-tenancy「注册即创建个人空间」）。
 *
 * - 注册后在 `databaseHooks.user.create.after` 中创建：`is_personal=true`，用户为 owner；
 *   新会话的 `active_organization_id` 默认指向个人空间（`session.create.before`）。
 * - 钩子与用户创建不在同一事务中，钩子失败只记日志、不让注册失败；`withWorkspace`
 *   找不到个人空间时调用 `ensurePersonalWorkspace` 补建。
 * - 幂等：个人空间的 id 取用户 id（同为 UUIDv7），organization 主键与 member 的
 *   `(organization_id, user_id)` 唯一约束保证并发补建不会产生第二个个人空间或重复的成员行。
 * - slug 为 `u-` + 8 位随机 base36，与已有 slug 冲突时换一个重试。
 */

export const PERSONAL_SLUG_PREFIX = 'u-'
const SLUG_RANDOM_LENGTH = 8
const SLUG_ATTEMPTS = 5
/** 个人空间的默认名称（用户可修改）；P6 接入 i18n 前先用英文 */
export const PERSONAL_WORKSPACE_NAME = 'Personal'

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** `u-` + 8 位随机 base36；用拒绝采样避免取模偏差 */
export function personalSlug(): string {
  let out = ''
  while (out.length < SLUG_RANDOM_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SLUG_RANDOM_LENGTH))) {
      // 252 = 36 * 7：丢弃 252–255，其余字节均匀映射到 36 个字符
      if (byte < 252 && out.length < SLUG_RANDOM_LENGTH) out += BASE36[byte % 36]
    }
  }
  return PERSONAL_SLUG_PREFIX + out
}

/** 用户的个人空间（含已软删的）；不存在时返回 `undefined` */
export async function findPersonalWorkspace(
  db: Database,
  userId: string,
): Promise<Organization | undefined> {
  return db.query.organization.findFirst({
    where: (o, { and, eq }) => and(eq(o.id, userId), eq(o.isPersonal, true)),
  })
}

/** Postgres 唯一约束冲突中的 slug 冲突（organization_slug_unique） */
function isSlugConflict(error: unknown): boolean {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    const { code, constraint_name } = e as { code?: string; constraint_name?: string }
    if (code === '23505' && constraint_name === 'organization_slug_unique') return true
  }
  return false
}

/**
 * 确保用户有个人空间且是其 owner，返回该空间。可重复、并发调用：
 * 空间已存在时不改动它，成员行已存在时不重复插入。
 */
export async function ensurePersonalWorkspace(
  db: Database,
  user: { readonly id: string },
): Promise<Organization> {
  let workspace = await findPersonalWorkspace(db, user.id)
  for (let attempt = 1; !workspace; attempt++) {
    try {
      await db
        .insert(organization)
        .values({
          id: user.id,
          name: PERSONAL_WORKSPACE_NAME,
          slug: personalSlug(),
          isPersonal: true,
        })
        // 并发创建时另一方已插入：保留先插入的那个
        .onConflictDoNothing({ target: organization.id })
    } catch (error) {
      if (!isSlugConflict(error) || attempt >= SLUG_ATTEMPTS) throw error
      continue
    }
    workspace = await findPersonalWorkspace(db, user.id)
    // id 被一个非个人空间占用：UUIDv7 不会碰撞，出现即为数据错误
    if (!workspace) throw new Error(`organization ${user.id} exists but is not personal`)
  }
  await scoped(db, workspace.id)
    .insert(member, { id: newId(), userId: user.id, role: 'owner' })
    .onConflictDoNothing()
  return workspace
}

/**
 * 接到 `createAuth` 的 `databaseHooks`：注册后创建个人空间；新会话没有活跃空间时指向个人空间。
 *
 * Better Auth 把 `create.after` 推迟到整个注册流程（`runWithTransaction`）结束后执行，
 * 注册时自动登录的会话已先于个人空间创建，因此钩子里补设该用户尚无活跃空间的会话。
 * 这只改数据库行，Cookie 缓存与 KV 中的副本仍为空，直到会话刷新；活跃空间为空时
 * `/app` 同样回退到个人空间，结果一致。之后登录创建的会话由 `session.create.before` 直接带上。
 */
export function personalWorkspaceHooks(db: Database) {
  return {
    user: {
      create: {
        after: async (user) => {
          try {
            const workspace = await ensurePersonalWorkspace(db, user)
            // 本包不直接依赖 drizzle-orm（见 test/helpers.ts），条件更新用参数化的原始 SQL
            await db.$client`
              update session set active_organization_id = ${workspace.id}
              where user_id = ${user.id} and active_organization_id is null`
          } catch (error) {
            // 不让注册失败：withWorkspace 会补建（design.md 决策 4）
            console.error(
              JSON.stringify({
                event: 'personal_workspace.create_failed',
                userId: user.id,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          if (session.activeOrganizationId) return
          const personal = await findPersonalWorkspace(db, session.userId)
          if (!personal || personal.deletedAt) return
          return { data: { ...session, activeOrganizationId: personal.id } }
        },
      },
    },
  } satisfies BetterAuthOptions['databaseHooks']
}
