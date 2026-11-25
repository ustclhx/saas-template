import { createDb, type HyperdriveBinding } from '@saas/db'
import {
  AppError,
  isRetryGiveUpError,
  isWorkersTransientMessage,
  type RetryClassification,
  type RetryTransientOptions,
  retryTransient,
} from '@saas/shared'
import { log, newRequestId } from '@saas/shared/log'
import type {
  BackgroundTasks,
  ConfigScalar,
  DatabaseAccess,
  KeyValueStore,
  PlatformEnv,
  RateLimiter,
  RequestMetadata,
} from '../index.ts'

export * from './queue.ts'
export * from './scheduler.ts'
export * from './workflow.ts'

/** app 先用自己的 schema 校验，再显式挑选标量；不把原始 env/bindings 交给业务。 */
export function createCloudflareEnv<C extends { [K in keyof C]: ConfigScalar }>(
  config: C,
  capabilities: PlatformEnv['capabilities'],
): PlatformEnv<C> {
  return { config, capabilities }
}

/** 必须在每个请求/事件内创建；闭包只复用该次调用的客户端，不调用 sql.end。 */
export function createCloudflareDatabase(bindings: {
  HYPERDRIVE: HyperdriveBinding
  HYPERDRIVE_CACHED: HyperdriveBinding
}): DatabaseAccess {
  let business: ReturnType<typeof createDb> | undefined
  let publicData: ReturnType<typeof createDb> | undefined
  return {
    business: () => (business ??= createDb(bindings.HYPERDRIVE)),
    public: () => (publicData ??= createDb(bindings.HYPERDRIVE_CACHED)),
  }
}

/**
 * KV 写入/删除错误分类。同键 1 秒内多次写入抛出 `KV PUT failed: 429 Too Many Requests`，官方建议指数退避重试
 * （https://developers.cloudflare.com/kv/api/write-key-value-pairs/ 、
 * https://developers.cloudflare.com/kv/platform/limits/ ，2026-11-25）；5xx、网络中断与内部错误按临时错误重试；
 * 其余（参数错误等 4xx、无法识别）不重试。
 */
export function classifyKvError(error: unknown): RetryClassification {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const status = /^KV \w+ failed: (\d{3})\b/.exec(message)?.[1]
  if (status === '429') return { category: 'sameKeyRateLimit', code: status }
  if (status?.startsWith('5')) return { category: 'transient', code: status }
  if (status) return { category: 'fatal', code: status }
  if (isWorkersTransientMessage(message)) return { category: 'transient', code: 'network' }
  return { category: 'fatal' }
}

async function withKvRetry(
  operation: 'put' | 'delete',
  run: () => Promise<void>,
  options: Pick<RetryTransientOptions, 'sleep' | 'random'>,
) {
  try {
    await retryTransient(run, {
      ...options,
      classify: classifyKvError,
      onRetry: (info) => log.warn('cache.kv.retry', { operation, ...info }),
    })
  } catch (error) {
    if (!isRetryGiveUpError(error)) throw error
    // 参数错误等不可重试的错误保持原样，便于调用方定位；只有重试耗尽映射为 503。
    if (error.reason === 'non_retryable') throw error.cause
    const fields = {
      operation,
      category: error.category,
      code: error.code,
      transientRetries: error.retries.transient,
      sameKeyRetries: error.retries.sameKeyRateLimit,
    }
    log.warn(
      error.category === 'sameKeyRateLimit'
        ? 'cache.kv.same_key_rate_limited'
        : 'cache.kv.unavailable',
      fields,
    )
    throw new AppError('CACHE_UNAVAILABLE', 'Cache is unavailable', { status: 503 })
  }
}

/** `retry` 仅供测试注入等待与抖动；值均为字符串，可安全重放。 */
export function createCloudflareKv(
  binding: KVNamespace,
  retry: Pick<RetryTransientOptions, 'sleep' | 'random'> = {},
): KeyValueStore {
  function get(key: string): Promise<string | null>
  function get<T>(key: string, type: 'json'): Promise<T | null>
  function get<T>(key: string, type?: 'json'): Promise<T | string | null> {
    return type === 'json' ? binding.get<T>(key, 'json') : binding.get(key)
  }
  return {
    get,
    put: (key, value, options) =>
      withKvRetry(
        'put',
        () =>
          binding.put(
            key,
            value,
            options?.expirationTtl === undefined
              ? undefined
              : { expirationTtl: Math.max(60, options.expirationTtl) },
          ),
        retry,
      ),
    delete: (key) => withKvRetry('delete', () => binding.delete(key), retry),
  }
}

export function createCloudflareRateLimiter(bindings: {
  RL_AUTH?: RateLimit
  RL_AI?: RateLimit
  RL_API?: RateLimit
  RL_SHARE_CARD?: RateLimit
  RL_ADMIN_MCP?: RateLimit
}): RateLimiter {
  const policies = {
    auth: bindings.RL_AUTH,
    ai: bindings.RL_AI,
    api: bindings.RL_API,
    shareCard: bindings.RL_SHARE_CARD,
    'admin-mcp': bindings.RL_ADMIN_MCP,
  }
  return {
    limit(policy, key) {
      const binding = policies[policy]
      if (!binding)
        throw new AppError('CAPABILITY_UNAVAILABLE', `${policy} rate limit is unavailable`, {
          status: 503,
        })
      return binding.limit({ key })
    },
  }
}

export function createCloudflareBackgroundTasks(
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): BackgroundTasks {
  return { waitUntil: (promise) => ctx.waitUntil(promise) }
}

/** 仅可信 CF composition entry 调用；Node 不得把 cf-connecting-ip 作为客户端 IP。 */
export function createCloudflareRequestMetadata(request: Request): RequestMetadata {
  const cfRay = request.headers.get('cf-ray')
  return {
    requestId: newRequestId(),
    clientIp: request.headers.get('cf-connecting-ip'),
    ...(cfRay === null ? {} : { cfRay }),
  }
}
