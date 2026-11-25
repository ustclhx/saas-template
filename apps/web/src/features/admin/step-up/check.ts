import { isRescueEnabled, listStepUpMethods, type StepUpMethod } from '@saas/auth'
import { adminStepUp, type Database } from '@saas/db'
import { AppError } from '@saas/shared'
import { and, eq, gt } from 'drizzle-orm'
import { type AdminActionRef, requiresStepUp } from '../actions.registry.ts'

/**
 * 敏感后台操作的重新验证检查（openspec add-admin-step-up design.md 决策 2、4）。
 * 在包装开启事务、产生任何副作用之前调用；验证状态直接读库（不走缓存），
 * 只认绑定到当前会话、属于当前管理员且未过期的记录。
 * 拒绝时 `details.methods` 列出该账号可用的验证方式（step-up/service.server.ts、
 * step-up.functions.ts 提供验证入口）。
 */

export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED'

/**
 * 重新验证的强制开关。验证方式（第 2 组）与弹窗（第 4 组）上线前保持关闭，避免管理员被锁在
 * 敏感操作之外：关闭时 assertStepUp 直接放行，登记表、类型约束与守卫扫描照常生效。
 * 第 4 组 4.2 完成时改为 true，并删除本开关与 overrideStepUpEnforcedForTesting。
 */
export const STEP_UP_ENFORCED = false

let enforcedOverride: boolean | undefined

/** 仅供测试：强制开启（或关闭）检查以覆盖拒绝与放行；传 undefined 恢复为 STEP_UP_ENFORCED */
export function overrideStepUpEnforcedForTesting(value: boolean | undefined) {
  enforcedOverride = value
}

function stepUpEnforced(): boolean {
  return enforcedOverride ?? STEP_UP_ENFORCED
}

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
  return new AppError(STEP_UP_REQUIRED, 'Re-verify your identity to continue', {
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
  // 关闭时也先判定：未登记的动作名在运行时同样报错
  if (!(await requiresStepUp(ref, { db: context.db }))) return
  if (!stepUpEnforced()) return
  const session = context.session
  // 会话必须属于执行操作的管理员；模拟会话等身份不一致时同样拒绝。
  if (session && session.userId === context.admin.id && (await hasValidStepUp(context.db, session)))
    return
  // 无会话（MCP 等）时没有可在此完成的验证方式
  throw stepUpRequiredError(
    session ? await listStepUpMethods(context.db, context.admin.id, await rescueConfig()) : [],
  )
}
