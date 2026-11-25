import { isAiFaultInjectionEnabled } from '@saas/config'
import { type JsonValue, user } from '@saas/db'
import { AppError } from '@saas/shared'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { AdminAccessRevokedError } from '@web/features/admin/action.ts'
import { adminMiddleware } from '@web/features/admin/admin.functions.ts'
import {
  confirmPendingAction,
  countPendingActions,
  getPendingAction,
  listPendingActions,
  rejectPendingActionAndDropSecret,
} from '@web/features/admin/confirmations/service.ts'
import { ADMIN_MAX_OFFSET, ADMIN_PAGE_SIZE } from '@web/features/admin/list.ts'
import { STEP_UP_REQUIRED } from '@web/features/admin/step-up/check.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'

// 后台确认 / 拒绝 AI（admin MCP）发起的敏感操作（openspec add-admin-step-up 任务 3.4）。
// - 确认：动作名 admin.confirmation.confirm（敏感，需当前会话已重新验证），只有发起令牌所属管理员可执行；
// - 拒绝：动作名 admin.confirmation.reject（不敏感），任何有效管理员可执行。
// 重新验证未通过时原样抛出 STEP_UP_REQUIRED，交给后台统一的调用包装（useStepUpCall）弹出验证；
// 记录不存在、非发起人、已处理或已过期等结果以 { ok: false, error } 返回，页面据此展示状态。

const input = z.object({ id: z.uuid() })

type Failure = { readonly ok: false; readonly error: string; readonly message: string }

function settle(error: unknown): Failure {
  if (error instanceof AdminAccessRevokedError) throw notFound()
  if (error instanceof AppError && error.code === STEP_UP_REQUIRED) throw error
  if (error instanceof AppError && error.expose && error.status < 500)
    return { ok: false, error: error.code, message: error.message }
  throw error
}

export const confirmAdminConfirmation = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(input)
  .handler(async ({ context, data }) => {
    const runtime = getWebRuntime()
    const ai = runtime.ai
    const env = {
      cache: runtime.cache,
      workersAiAvailable: ai?.available === true && ai.value.workersAi.available,
      aiFaultInjectionEnabled: isAiFaultInjectionEnabled(
        ai?.available === true ? ai.value.config : {},
      ),
    }
    // 工具模块只在服务端按需加载，不进入后台页面的客户端包
    const { adminTools } = await import('./tools/index.ts')
    try {
      const outcome = await confirmPendingAction(
        { ...context, cache: runtime.cache },
        data.id,
        (record) => adminTools.find((tool) => tool.spec.name === record.tool)?.execute?.(env),
      )
      return { ok: true as const, ...outcome }
    } catch (error) {
      return settle(error)
    }
  })

export const rejectAdminConfirmation = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(input)
  .handler(async ({ context, data }) => {
    try {
      const outcome = await rejectPendingActionAndDropSecret(
        { ...context, cache: getWebRuntime().cache },
        data.id,
      )
      return { ok: true as const, ...outcome }
    } catch (error) {
      return settle(error)
    }
  })

// ---------------------------------------------------------------------------
// 读取：确认页、待确认列表与导航计数（任务 4.3）。只读页面不要求重新验证（决策 5），
// 视图不含执行参数与密文；记录不存在时返回 found: false，由页面展示「不存在」状态。
// ---------------------------------------------------------------------------

type View = NonNullable<Awaited<ReturnType<typeof getPendingAction>>>

/** jsonb 列在类型上是 unknown；这里的值来自服务端自己写入的 JSON，按 JsonValue 交给客户端 */
function serializable(view: View) {
  return {
    id: view.id,
    tool: view.tool,
    action: view.action,
    summary: view.summary,
    display: (view.display ?? {}) as JsonValue,
    status: view.status,
    result: (view.result ?? null) as JsonValue,
    requestedBy: view.requestedBy,
    decidedBy: view.decidedBy,
    decidedAt: view.decidedAt,
    expiresAt: view.expiresAt,
    createdAt: view.createdAt,
    hasSecret: view.hasSecret,
    token: view.token,
  }
}

export type AdminConfirmationView = ReturnType<typeof serializable>

export const getAdminConfirmation = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.string().max(64) }))
  .handler(async ({ context, data }) => {
    const now = new Date()
    // 非 UUID 的链接直接视为不存在，不进数据库
    const view = z.uuid().safeParse(data.id).success
      ? await getPendingAction(context.db, data.id)
      : undefined
    if (!view) return { found: false as const, now }
    const ids = [view.requestedBy, view.decidedBy].filter((id): id is string => id !== null)
    const people = await context.db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(inArray(user.id, ids))
    const emailOf = (id: string | null) => people.find((row) => row.id === id)?.email ?? null
    return {
      found: true as const,
      now,
      record: serializable(view),
      isOwner: view.requestedBy === context.admin.id,
      requestedByEmail: emailOf(view.requestedBy),
      decidedByEmail: emailOf(view.decidedBy),
    }
  })

export const listAdminConfirmations = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({
      view: z.enum(['pending', 'history']).default('pending'),
      offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET).default(0),
    }),
  )
  .handler(async ({ context, data }) => {
    const list = await listPendingActions(context.db, {
      view: data.view,
      offset: data.offset,
      limit: ADMIN_PAGE_SIZE,
    })
    // 列表读取已惰性过期，计数与列表一致
    const pending = await countPendingActions(context.db)
    return {
      now: new Date(),
      rows: list.rows.map(serializable),
      hasMore: list.hasMore,
      pending,
    }
  })

/** 后台导航上的待确认数量 */
export const countAdminConfirmations = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(({ context }) => countPendingActions(context.db))
