import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getWebRuntime } from '../../../server/runtime.ts'
import { adminMiddleware } from '../admin.functions.ts'
import { STEP_UP_ENFORCED } from './check.ts'
import { createWebStepUp, notifyRescue } from './service.server.ts'

// 后台重新验证的 Server Functions（add-admin-step-up tasks 2.2，design.md 决策 3–5、10）。
// 均经 adminMiddleware（requireAdmin：实时会话、非模拟、平台管理员），只作用于当前会话；
// 不创建、不替换会话。预期内的失败（验证码错误、锁定、冷却等）以 `{ ok: false }` 返回，
// 由验证弹窗（第 4 组）展示；其他错误照常抛出。

const stepUpMethod = z.enum(['totp', 'backup_code', 'email_otp', 'password', 'rescue'])

/** 失败详情只含标量与字符串数组（锁定时间、剩余次数、可用方式等），可经 Server Function 序列化 */
export type StepUpDetail = string | number | boolean | null | string[]

export type StepUpFailure = {
  readonly ok: false
  readonly error: string
  readonly details?: Record<string, StepUpDetail>
}

function failure(error: unknown): StepUpFailure {
  if (!(error instanceof AppError) || error.status >= 500) throw error
  return {
    ok: false,
    error: error.code,
    ...(error.publicDetails
      ? { details: error.publicDetails as Record<string, StepUpDetail> }
      : {}),
  }
}

const sessionOf = (context: { session: { id: string; userId: string } | null | undefined }) => {
  // adminMiddleware 总会提供当前会话；缺失说明调用链被改动，按服务端错误处理
  if (!context.session) throw new Error('Admin session missing')
  return context.session
}

/** 后台顶部状态与验证弹窗的数据：剩余有效期、可用方式、救援模式、锁定与验证码冷却 */
export const getStepUpStatus = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    const service = await createWebStepUp(getWebRuntime())
    const status = await service.status(sessionOf(context))
    return {
      enforced: STEP_UP_ENFORCED,
      verified: status.verified && {
        method: status.verified.method,
        expiresAt: status.verified.expiresAt.toISOString(),
      },
      methods: status.methods,
      rescueMode: status.rescueMode,
      lockedUntil: status.lockedUntil?.toISOString() ?? null,
      email: status.email,
      code: status.code && {
        expiresAt: status.code.expiresAt.toISOString(),
        resendAt: status.code.resendAt.toISOString(),
      },
    }
  })

/** 向当前管理员的已验证邮箱发送验证码（`rescue` 仅在救援开关开启且在引导名单内时可用） */
export const sendStepUpCode = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ method: z.enum(['email_otp', 'rescue']).default('email_otp') }))
  .handler(async ({ context, data }) => {
    const runtime = getWebRuntime()
    try {
      // 先确认邮件队列可用，避免写入验证码后发不出去还要等冷却
      if (!runtime.emailQueue.available)
        throw new AppError('EMAIL_UNAVAILABLE', 'Email is unavailable', { status: 503 })
      const service = await createWebStepUp(runtime)
      const sent = await service.sendCode(sessionOf(context), data.method)
      return {
        ok: true as const,
        method: sent.method,
        email: sent.email,
        expiresAt: sent.expiresAt.toISOString(),
        resendAt: sent.resendAt.toISOString(),
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'EMAIL_UNAVAILABLE')
        return { ok: false as const, error: error.code }
      return failure(error)
    }
  })

/** 校验一次重新验证；成功后当前会话在有效期内可执行敏感操作 */
export const verifyStepUp = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(
    z.discriminatedUnion('method', [
      z.object({ method: z.literal('password'), password: z.string().min(1).max(1024) }),
      z.object({
        method: stepUpMethod.exclude(['password']),
        code: z.string().trim().min(1).max(64),
      }),
    ]),
  )
  .handler(async ({ context, data }) => {
    const runtime = getWebRuntime()
    try {
      const service = await createWebStepUp(runtime)
      const verified = await service.verify(sessionOf(context), data)
      await notifyRescue(runtime, verified)
      return {
        ok: true as const,
        method: verified.method,
        expiresAt: verified.expiresAt.toISOString(),
      }
    } catch (error) {
      return failure(error)
    }
  })
