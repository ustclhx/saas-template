/**
 * 平台临时错误的有限次重试。分类器由各目标适配层提供；本模块只负责计数、退避与抖动。
 * 参数依据见 openspec change add-ops-safeguards design D6（R2 错误码页、R2/KV 限制页、KV 写入页，2026-11-25）。
 */

/** transient：内部错误、服务暂不可用、网络中断；sameKeyRateLimit：同键写入过快；fatal：不可重试。 */
export type RetryCategory = 'transient' | 'sameKeyRateLimit' | 'fatal'

export interface RetryClassification {
  readonly category: RetryCategory
  /** 平台错误码或状态（如 R2 `10043`、KV `429`），只用于日志，不得包含键或用户数据。 */
  readonly code?: string
}

export interface RetryCounts {
  readonly transient: number
  readonly sameKeyRateLimit: number
}

export interface RetryAttemptInfo extends RetryCounts {
  readonly category: Exclude<RetryCategory, 'fatal'>
  readonly code: string | undefined
  readonly delayMs: number
}

export interface RetryTransientOptions {
  readonly classify: (error: unknown) => RetryClassification
  /** 测试注入；默认 setTimeout。 */
  readonly sleep?: (ms: number) => Promise<void>
  /** 测试注入；默认 Math.random，返回 [0, 1)。 */
  readonly random?: () => number
  readonly onRetry?: (info: RetryAttemptInfo) => void
}

/** 临时错误：最多重试 3 次，100/300/900 ms，各 ±50% 抖动。 */
export const TRANSIENT_RETRY_DELAYS_MS = [100, 300, 900] as const
/** 同键限流：同键 1 次/秒，按官方建议从 1 秒起指数退避，最多重试 2 次，各加 0–250 ms 抖动。 */
export const SAME_KEY_RETRY_DELAYS_MS = [1000, 2000] as const
const SAME_KEY_JITTER_MS = 250

/** 重试耗尽或遇到不可重试错误时抛出；`cause` 为最后一次的原始错误，适配层负责映射为业务错误。 */
export class RetryGiveUpError extends Error {
  override readonly name = 'RetryGiveUpError'
  readonly reason: 'exhausted' | 'non_retryable'
  readonly category: RetryCategory
  readonly code: string | undefined
  readonly retries: RetryCounts

  constructor(
    reason: 'exhausted' | 'non_retryable',
    classification: RetryClassification,
    retries: RetryCounts,
    cause: unknown,
  ) {
    super(`Retry gave up (${reason}, ${classification.category})`, { cause })
    this.reason = reason
    this.category = classification.category
    this.code = classification.code
    this.retries = retries
  }
}

export function isRetryGiveUpError(error: unknown): error is RetryGiveUpError {
  return error instanceof RetryGiveUpError
}

/**
 * Workers 运行时「Network connection lost」与 workerd 不透明的 `internal error; reference = …`。
 * https://developers.cloudflare.com/workers/observability/errors/ （2026-11-25）：
 * 「Catch a fetch or binding invocation and retry it」。只做字符串判断，不依赖平台类型。
 */
export function isWorkersTransientMessage(message: string) {
  return /network connection lost/i.test(message) || /^internal error\b/i.test(message)
}

// shared 源码不依赖宿主全局类型（部分包未启用 DOM lib），通过 globalThis 取 setTimeout。
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown
}
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms)
  })

function delayFor(category: 'transient' | 'sameKeyRateLimit', index: number, random: () => number) {
  if (category === 'transient') {
    const base = TRANSIENT_RETRY_DELAYS_MS[index] ?? 0
    return Math.round(base * (0.5 + random()))
  }
  const base = SAME_KEY_RETRY_DELAYS_MS[index] ?? 0
  return base + Math.round(random() * SAME_KEY_JITTER_MS)
}

/**
 * 两类可重试错误各自计数，交替出现时互不消耗对方次数；单次调用最多 1 + 3 + 2 次尝试。
 * 只用于幂等操作或可重放请求体的写入。
 */
export async function retryTransient<T>(
  operation: () => Promise<T>,
  { classify, sleep = defaultSleep, random = Math.random, onRetry }: RetryTransientOptions,
): Promise<T> {
  let transient = 0
  let sameKeyRateLimit = 0
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      const classification = classify(error)
      const retries = { transient, sameKeyRateLimit }
      if (classification.category === 'fatal')
        throw new RetryGiveUpError('non_retryable', classification, retries, error)
      const used = classification.category === 'transient' ? transient : sameKeyRateLimit
      const limit =
        classification.category === 'transient'
          ? TRANSIENT_RETRY_DELAYS_MS.length
          : SAME_KEY_RETRY_DELAYS_MS.length
      if (used >= limit) throw new RetryGiveUpError('exhausted', classification, retries, error)
      const delayMs = delayFor(classification.category, used, random)
      if (classification.category === 'transient') transient++
      else sameKeyRateLimit++
      onRetry?.({
        category: classification.category,
        code: classification.code,
        delayMs,
        transient,
        sameKeyRateLimit,
      })
      await sleep(delayMs)
    }
  }
}
