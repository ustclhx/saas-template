import { APICallError } from 'ai'
import { type FailureKind, failureKindFromStatus, failureKindOf } from './failure.ts'

/**
 * 文本模型错误分类（add-media-provider-fallback 决策 D7）：AI SDK 的 `APICallError` 按 HTTP 状态归类
 * （429 → rate_limited，401/403 → auth，5xx → provider_error，其余 4xx → rejected_input，
 * 无状态码的网络错误 → provider_error），其他异常沿用共用的 `failureKindOf`。
 * 出处：AI SDK `APICallError`（https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error，
 * 与已安装 @ai-sdk/provider 4.0.21 类型核对于 2026-11-27）。
 */
export function failureKindOfTextError(error: unknown): FailureKind {
  if (APICallError.isInstance(error)) return failureKindFromStatus(error.statusCode)
  return failureKindOf(error)
}
