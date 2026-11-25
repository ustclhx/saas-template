import { adminStepUp, type Database } from '@saas/db'
import { AppError } from '@saas/shared'
import { and, eq, gt } from 'drizzle-orm'
import { type AdminActionRef, requiresStepUp } from '../actions.registry.ts'

/**
 * 敏感后台操作的重新验证检查（openspec add-admin-step-up design.md 决策 2、4）。
 * 在包装开启事务、产生任何副作用之前调用；验证状态直接读库（不走缓存），
 * 只认绑定到当前会话、属于当前管理员且未过期的记录。
 * 验证方式（`details.methods`）与验证入口由第 2 组补齐。
 */

export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED'

/** 后台请求的当前会话；MCP 等无会话的调用为空，敏感动作因此一律被拒 */
export interface AdminSessionRef {
  readonly id: string
  readonly userId: string
}

export async function hasValidStepUp(
  db: Database,
  session: AdminSessionRef,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ sessionId: adminStepUp.sessionId })
    .from(adminStepUp)
    .where(
      and(
        eq(adminStepUp.sessionId, session.id),
        eq(adminStepUp.userId, session.userId),
        gt(adminStepUp.expiresAt, now),
      ),
    )
    .limit(1)
  return row !== undefined
}

export function stepUpRequiredError() {
  return new AppError(STEP_UP_REQUIRED, 'Re-verify your identity to continue', { status: 403 })
}

export async function assertStepUp(
  context: {
    readonly db: Database
    readonly admin: { readonly id: string }
    readonly session?: AdminSessionRef | null | undefined
  },
  ref: AdminActionRef,
): Promise<void> {
  if (!(await requiresStepUp(ref, { db: context.db }))) return
  const session = context.session
  // 会话必须属于执行操作的管理员；模拟会话等身份不一致时同样拒绝。
  if (session && session.userId === context.admin.id && (await hasValidStepUp(context.db, session)))
    return
  throw stepUpRequiredError()
}
