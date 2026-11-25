import type { StepUpMethod } from '@saas/auth'

/**
 * 后台重新验证的客户端判定（openspec add-admin-step-up 决策 10）。纯函数，不依赖 React，
 * 供 useStepUpCall、服务端入口与测试使用。服务端以 AppError(`STEP_UP_REQUIRED`) 拒绝。
 *
 * TanStack Start 1.168 把 Server Function 抛出的错误按 `$TSR/Error` 序列化，只保留 `message`
 * （`code` 与 `publicDetails` 不会到达浏览器，2026-11-26 用 e2e 抓包核对），所以浏览器端按
 * 固定的错误消息识别；可用方式由验证弹窗打开时经 getStepUpStatus 读取。服务端与测试中的 AppError
 * 仍按 `code` 识别。
 */

export const STEP_UP_REQUIRED_CODE = 'STEP_UP_REQUIRED'
/** STEP_UP_REQUIRED 的错误消息；check.ts 的 stepUpRequiredError 使用同一常量，不能单独修改 */
export const STEP_UP_REQUIRED_MESSAGE = 'Re-verify your identity to continue'

/** 用户在验证弹窗中取消：操作未执行，调用方保持表单原样即可 */
export const STEP_UP_CANCELLED: unique symbol = Symbol('step-up-cancelled')
export type StepUpCancelled = typeof STEP_UP_CANCELLED

export function isStepUpCancelled(value: unknown): value is StepUpCancelled {
  return value === STEP_UP_CANCELLED
}

const KNOWN_METHODS: readonly StepUpMethod[] = [
  'totp',
  'backup_code',
  'email_otp',
  'password',
  'rescue',
]

function methodsOf(value: unknown): StepUpMethod[] {
  if (!value || typeof value !== 'object' || !('methods' in value)) return []
  const methods = value.methods
  return Array.isArray(methods)
    ? methods.filter((item): item is StepUpMethod => KNOWN_METHODS.includes(item as StepUpMethod))
    : []
}

/**
 * 错误为 `STEP_UP_REQUIRED` 时返回其中带的可用方式（可能为空：浏览器端拿不到详情），否则返回 undefined。
 * 按 `code` 识别；没有 `code` 的 Error（经 Server Function 传回浏览器）按消息识别。
 */
export function stepUpRequiredMethods(error: unknown): StepUpMethod[] | undefined {
  if (!error || typeof error !== 'object') return undefined
  const matched =
    'code' in error
      ? error.code === STEP_UP_REQUIRED_CODE
      : error instanceof Error && error.message === STEP_UP_REQUIRED_MESSAGE
  if (!matched) return undefined
  const source = error as { publicDetails?: unknown; details?: unknown }
  const fromPublic = methodsOf(source.publicDetails)
  return fromPublic.length > 0 ? fromPublic : methodsOf(source.details)
}

/**
 * 服务端把业务错误包装为 `{ ok: false, error }` 返回的入口，在 catch 中先调用它：
 * `STEP_UP_REQUIRED` 必须原样抛出，客户端的 useStepUpCall 才能弹出验证并重试。
 */
export function rethrowStepUpRequired(error: unknown): void {
  if (stepUpRequiredMethods(error) !== undefined) throw error
}

/** 剩余有效期按整分钟向上取整，不足一分钟显示 1 */
export function minutesLeft(expiresAt: string | Date, now: number): number {
  const ms = new Date(expiresAt).getTime() - now
  return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 60_000))
}

/** 重发冷却的剩余秒数 */
export function secondsLeft(at: string | Date | null | undefined, now: number): number {
  if (!at) return 0
  return Math.max(0, Math.ceil((new Date(at).getTime() - now) / 1000))
}
