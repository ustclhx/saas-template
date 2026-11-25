import { isRescueEnabled, listStepUpMethods, type StepUpMethod } from '@saas/auth'
import { adminStepUp, type Database } from '@saas/db'
import { AppError } from '@saas/shared'
import { and, eq, gt } from 'drizzle-orm'
import { type AdminActionRef, requiresStepUp } from '../actions.registry.ts'
import { STEP_UP_REQUIRED_MESSAGE } from './client.ts'

/**
 * 敏感后台操作的重新验证检查（openspec add-admin-step-up design.md 决策 2、4）。
 * 在包装开启事务、产生任何副作用之前调用；验证状态直接读库（不走缓存），
 * 只认绑定到当前会话、属于当前管理员且未过期的记录。
 * 拒绝时 `details.methods` 列出该账号可用的验证方式（step-up/service.server.ts、
 * step-up.functions.ts 提供验证入口）。
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

export function stepUpRequiredError(methods: readonly StepUpMethod[] = []) {
  const details = { methods: [...methods] }
  return new AppError(STEP_UP_REQUIRED, STEP_UP_REQUIRED_MESSAGE, {
    status: 403,
    details,
    publicDetails: details,
  })
}

/** 救援开关与引导名单：只来自部署环境，被盗会话无法改变（决策 5） */
export function stepUpRescueConfig(config: {
  readonly ADMIN_STEP_UP_RESCUE?: string | undefined
  readonly BOOTSTRAP_ADMIN_EMAILS?: string | undefined
}) {
  return {
    enabled: isRescueEnabled(config.ADMIN_STEP_UP_RESCUE),
    bootstrapEmails: config.BOOTSTRAP_ADMIN_EMAILS,
  }
}

/** 不在请求运行时内（单元测试、脚本）时视为救援关闭；动态读取避免静态依赖请求运行时 */
async function rescueConfig() {
  try {
    const { getWebRuntime } = await import('../../../server/runtime.ts')
    const config = getWebRuntime()?.config
    return config ? stepUpRescueConfig(config) : undefined
  } catch {
    return undefined
  }
}

export async function assertStepUp(
  context: {
    readonly db: Database
    readonly admin: { readonly id: string }
    readonly session?: AdminSessionRef | null | undefined
  },
  ref: AdminActionRef,
): Promise<void> {
  // 未登记的动作名在判定时报错
  if (!(await requiresStepUp(ref, { db: context.db }))) return
  const session = context.session
  // 会话必须属于执行操作的管理员；模拟会话等身份不一致时同样拒绝。
  if (session && session.userId === context.admin.id && (await hasValidStepUp(context.db, session)))
    return
  // 无会话（MCP 等）时没有可在此完成的验证方式
  throw stepUpRequiredError(
    session ? await listStepUpMethods(context.db, context.admin.id, await rescueConfig()) : [],
  )
}
