import { isAiFaultInjectionEnabled } from '@saas/config'
import { AppError } from '@saas/shared'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { AdminAccessRevokedError } from '@web/features/admin/action.ts'
import { adminMiddleware } from '@web/features/admin/admin.functions.ts'
import {
  confirmPendingAction,
  rejectPendingActionAndDropSecret,
} from '@web/features/admin/confirmations/service.ts'
import { STEP_UP_REQUIRED } from '@web/features/admin/step-up/check.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { z } from 'zod'

// 后台确认 / 拒绝 AI（admin MCP）发起的敏感操作（openspec add-admin-step-up 任务 3.4）。
// - 确认：动作名 admin.confirmation.confirm（敏感，需当前会话已重新验证），只有发起令牌所属管理员可执行；
// - 拒绝：动作名 admin.confirmation.reject（不敏感），任何有效管理员可执行。
// 重新验证未通过时原样抛出 STEP_UP_REQUIRED，交给后台统一的调用包装弹出验证（第 4 组）；
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
