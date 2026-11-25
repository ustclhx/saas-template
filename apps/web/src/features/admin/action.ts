import { auditLog, type Database, type NewAuditLog, type User, user } from '@saas/db'
import { AppError } from '@saas/shared'
import { eq } from 'drizzle-orm'
import type { AdminActionRef } from './actions.registry.ts'
import { isPlatformAdmin } from './guard.ts'
import { type AdminSessionRef, assertStepUp, STEP_UP_REQUIRED } from './step-up/check.ts'

/**
 * 后台写操作的统一包装（add-admin-console design.md 决策 1，tasks.md 1.1）。
 *
 * - 实时校验：`adminMiddleware` 在请求开始时已按数据库校验会话与角色（requireFreshSession）；
 *   这里在写事务内再次读取管理员行并加共享锁，角色被撤销或被封禁后的写入一律拒绝，
 *   降级与正在执行的后台写操作互相等待，不会出现「已降级但操作仍提交」。
 * - 审计与业务同事务：handler 通过 `audit()` 写审计，与业务写入在同一事务中提交或回滚；
 *   handler 没有写审计时整个事务回滚，避免「操作成功但没有审计」。
 *
 * 业务函数自己管理事务、并在其决策事务内写审计的操作（如 @saas/billing 的退款审核：
 * 决策先提交再调用支付平台）用 `runDelegatedAdminAction`，包装只做实时角色校验。
 *
 * 动作名必须在 `actions.registry.ts` 登记（add-admin-step-up 决策 1）；登记为敏感的动作在开启
 * 事务之前检查当前会话的重新验证（决策 2），未验证时以 `STEP_UP_REQUIRED` 拒绝，不产生任何写入。
 */

export type AdminTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface AdminActionContext {
  readonly db: Database
  readonly admin: Pick<User, 'id'>
  /** 来源 IP（由目标入口完成代理信任校验） */
  readonly ip?: string | null
  /**
   * 当前后台会话（来自 requireFreshSession），用于检查重新验证。
   * MCP 等无会话的调用不设置；此时敏感动作一律被拒，不会以「无会话」绕过。
   */
  readonly session?: AdminSessionRef | null | undefined
  /**
   * 由服务端确认执行路径构造的确认信息（决策 8，第 3 组实现）。
   * 目前只声明类型、不放行：敏感动作仍要求会话已重新验证。
   */
  readonly confirmation?: AdminActionConfirmation
}

export interface AdminActionConfirmation {
  readonly id: string
  readonly confirmedBy: string
  readonly stepUpMethod: string
}

/** 审计记录中由 handler 决定的部分；操作人与来源 IP 由包装填入 */
export type AdminAuditEntry = Pick<
  NewAuditLog,
  'action' | 'targetType' | 'targetId' | 'workspaceId' | 'meta'
>

export interface AdminActionScope {
  readonly admin: Pick<User, 'id'>
  readonly tx: AdminTransaction
  audit(entry: AdminAuditEntry): Promise<void>
}

export const ADMIN_ACTION_UNAUDITED = 'ADMIN_ACTION_UNAUDITED'

/**
 * 写事务内发现管理员已被降级或封禁。与业务错误（含业务自己的 NOT_FOUND）区分开，
 * 由 server function 包装统一转换为与守卫相同的 404。
 */
export class AdminAccessRevokedError extends Error {
  constructor() {
    super('Admin access revoked')
    this.name = 'AdminAccessRevokedError'
  }
}

export function isActiveAdmin(
  row: Pick<User, 'role' | 'banned' | 'banExpires'> | undefined,
): boolean {
  if (!row || !isPlatformAdmin(row.role)) return false
  // 与 requireFreshSession 一致：banExpires 为空表示永久封禁
  return !(row.banned === true && (row.banExpires === null || row.banExpires > new Date()))
}

async function assertActiveAdmin(db: Database | AdminTransaction, userId: string, lock: boolean) {
  const query = db
    .select({ role: user.role, banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId))
  const [row] = lock ? await query.for('share') : await query
  if (!isActiveAdmin(row)) throw new AdminAccessRevokedError()
}

function actionName(action: AdminActionRef): string {
  return typeof action === 'string' ? action : action.name
}

/** 拒绝前先确认仍是有效管理员：已降级或被封禁时与其他入口一样得到 404，而不是要求验证。 */
async function checkStepUp(context: AdminActionContext, action: AdminActionRef) {
  try {
    await assertStepUp(context, action)
  } catch (error) {
    if (error instanceof AppError && error.code === STEP_UP_REQUIRED)
      await assertActiveAdmin(context.db, context.admin.id, false)
    throw error
  }
}

export async function runAdminAction<T>(
  context: AdminActionContext,
  action: AdminActionRef,
  handler: (scope: AdminActionScope) => Promise<T>,
): Promise<T> {
  const name = actionName(action)
  await checkStepUp(context, action)
  return context.db.transaction(async (tx) => {
    await assertActiveAdmin(tx, context.admin.id, true)
    let audited = false
    const result = await handler({
      admin: context.admin,
      tx,
      audit: async (entry) => {
        // biome-ignore lint/plugin: Platform-admin audit records the explicit workspace of the action, if any.
        await tx.insert(auditLog).values({
          ...entry,
          actorUserId: context.admin.id,
          ip: context.ip ?? null,
        })
        audited = true
      },
    })
    if (!audited)
      throw new AppError(ADMIN_ACTION_UNAUDITED, `Admin action ${name} wrote no audit record`, {
        status: 500,
      })
    return result
  })
}

export async function runDelegatedAdminAction<T>(
  context: AdminActionContext,
  action: AdminActionRef,
  handler: (db: Database) => Promise<T>,
): Promise<T> {
  await assertActiveAdmin(context.db, context.admin.id, false)
  await checkStepUp(context, action)
  return handler(context.db)
}
