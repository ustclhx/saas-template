import { AppError } from '@saas/shared'

/**
 * 服务商失败分类（add-media-provider-fallback 决策 D3）：文本与媒体共用口径，决定能否切换到备用模型。
 * - unavailable：服务商未启用或未配置凭据
 * - rate_limited：限流（429 或服务商的并发 / 配额拒绝）
 * - provider_error：服务端错误、上游内部错误、网络异常，以及无法识别的失败
 * - auth：凭据无效或被吊销（401 / 403）
 * - rejected_input：请求本身被拒（参数、输入过长）
 * - content_policy：内容审核拒绝
 * - ambiguous：无法确定服务商是否已受理（提交超时、响应丢失）
 */
export const FAILURE_KINDS = [
  'unavailable',
  'rate_limited',
  'provider_error',
  'auth',
  'rejected_input',
  'content_policy',
  'ambiguous',
] as const

export type FailureKind = (typeof FAILURE_KINDS)[number]

const FAILOVER_KINDS: ReadonlySet<FailureKind> = new Set([
  'unavailable',
  'rate_limited',
  'provider_error',
  'auth',
])

/** 只有服务商侧原因可以切换；请求本身的问题换服务商也不会成功，不确定受理则可能重复生成。 */
export function canFailover(kind: FailureKind): boolean {
  return FAILOVER_KINDS.has(kind)
}

/** 按 HTTP 状态给出默认分类；适配器可再按上游错误类型细化（如内容审核）。 */
export function failureKindFromStatus(status: number | undefined): FailureKind {
  if (status === undefined) return 'provider_error'
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500) return 'provider_error'
  if (status >= 400) return 'rejected_input'
  return 'provider_error'
}

/** 带分类的服务商错误；不携带上游响应正文，避免泄露参数与密钥。 */
export class ProviderFailure extends AppError {
  readonly kind: FailureKind

  constructor(kind: FailureKind, code: string, message: string, options?: { status?: number }) {
    super(code, message, { status: options?.status ?? 502 })
    this.kind = kind
  }
}

/** 未分类的异常一律按 provider_error，但已知的业务拒绝（AppError 且非 5xx）按 rejected_input。 */
export function failureKindOf(error: unknown): FailureKind {
  if (error instanceof ProviderFailure) return error.kind
  if (error instanceof AppError) {
    if (error.code === 'AI_PROVIDER_NOT_CONFIGURED') return 'unavailable'
    if (error.status >= 500) return 'provider_error'
    return 'rejected_input'
  }
  return 'provider_error'
}
