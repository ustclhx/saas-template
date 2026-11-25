import {
  AppError,
  isRetryGiveUpError,
  isWorkersTransientMessage,
  type RetryClassification,
  type RetryTransientOptions,
  retryTransient,
} from '@saas/shared'
import { log } from '@saas/shared/log'

/**
 * R2 错误码分类，出处：https://developers.cloudflare.com/r2/api/error-codes/ （2026-11-25 核对）。
 * Workers 绑定抛出普通 Error，错误码在 message 末尾，如 `put: ... (10012)`；
 * 官方页原文「The error code is included at the end of the message property」，
 * 本地 workerd（miniflare 5.20261001）实测同一格式且无 code 属性（2026-11-25）。
 * 线上若另带 code/name 属性，也一并识别；无法识别的错误一律不重试。
 */
const TRANSIENT_CODES: Readonly<Record<string, string>> = {
  10001: 'InternalError', // 500「Retry the request」
  10043: 'ServiceUnavailable', // 503「Retry with exponential backoff」
  10054: 'ClientDisconnect', // 400「Check network connectivity and retry」
}
/** 同键 1 次/秒限制，见 https://developers.cloudflare.com/r2/platform/limits/ （2026-11-25）。 */
const SAME_KEY_CODES: Readonly<Record<string, string>> = { 10058: 'TooManyRequests' }

const TRANSIENT_NAMES = new Set(Object.values(TRANSIENT_CODES))
const SAME_KEY_NAMES = new Set(Object.values(SAME_KEY_CODES))

function errorParts(error: unknown) {
  if (typeof error !== 'object' || error === null) return { message: '', code: '', name: '' }
  const value = error as { message?: unknown; code?: unknown; name?: unknown }
  return {
    message: typeof value.message === 'string' ? value.message : '',
    code:
      typeof value.code === 'number' || typeof value.code === 'string' ? String(value.code) : '',
    name: typeof value.name === 'string' ? value.name : '',
  }
}

export function classifyR2Error(error: unknown): RetryClassification {
  const { message, code, name } = errorParts(error)
  const numeric = /^\d{5,6}$/.test(code) ? code : /\((\d{5,6})\)\s*$/.exec(message)?.[1]
  if (numeric) {
    if (numeric in SAME_KEY_CODES) return { category: 'sameKeyRateLimit', code: numeric }
    if (numeric in TRANSIENT_CODES) return { category: 'transient', code: numeric }
    return { category: 'fatal', code: numeric }
  }
  for (const label of [code, name]) {
    if (SAME_KEY_NAMES.has(label)) return { category: 'sameKeyRateLimit', code: label }
    if (TRANSIENT_NAMES.has(label)) return { category: 'transient', code: label }
  }
  if (isWorkersTransientMessage(message)) return { category: 'transient', code: 'network' }
  return { category: 'fatal' }
}

export type R2RetryOptions = Pick<RetryTransientOptions, 'sleep' | 'random'>

/**
 * 只包装幂等删除与可重放请求体的写入；ReadableStream 写入交给外层工作流重试。
 * 失败统一为 STORAGE_UNAVAILABLE（503），不携带原始错误，日志不含对象键。
 */
export async function withR2Retry<T>(
  operation: 'put' | 'delete',
  run: () => Promise<T>,
  options: R2RetryOptions = {},
): Promise<T> {
  try {
    return await retryTransient(run, {
      ...options,
      classify: classifyR2Error,
      onRetry: (info) => log.warn('storage.r2.retry', { operation, ...info }),
    })
  } catch (error) {
    if (!isRetryGiveUpError(error)) throw error
    const fields = {
      operation,
      reason: error.reason,
      category: error.category,
      code: error.code ?? (error.cause instanceof Error ? error.cause.name : typeof error.cause),
      transientRetries: error.retries.transient,
      sameKeyRetries: error.retries.sameKeyRateLimit,
    }
    // 同键限流耗尽单独标记：频繁出现说明有热点键，应改设计而不是加大重试。
    log.warn(
      error.category === 'sameKeyRateLimit'
        ? 'storage.r2.same_key_rate_limited'
        : 'storage.r2.unavailable',
      fields,
    )
    throw new AppError('STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable', {
      status: 503,
    })
  }
}
