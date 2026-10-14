import { getLogContext, sentryBeforeSend } from '@saas/shared/log'
import {
  type CloudflareOptions,
  captureException,
  getClient,
  getIsolationScope,
} from '@sentry/cloudflare'
import type { JobObserver } from './observer.ts'

export interface SentryEnv {
  SENTRY_DSN?: string
  SENTRY_ENVIRONMENT?: 'development' | 'staging' | 'production' | 'smoke'
  APP_VERSION?: string
}

/** 本地即使配置了真实 DSN，也不创建 Sentry client 或发送事件。 */
export function sentryEnabled(env: SentryEnv): boolean {
  return Boolean(
    env.SENTRY_DSN &&
      (env.SENTRY_ENVIRONMENT === 'staging' ||
        env.SENTRY_ENVIRONMENT === 'production' ||
        env.SENTRY_ENVIRONMENT === 'smoke'),
  )
}

export function sentryOptions(env: SentryEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.APP_VERSION,
    dist: 'jobs',
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: 0,
    beforeSend: sentryBeforeSend,
  }
}

export function tagJobContext(): void {
  if (!getClient()) return
  const { requestId, workspaceId, userId } = getLogContext()
  getIsolationScope().setTags({ requestId, workspaceId, userId })
}

/** 队列主动重试与 Workflow 外围异常不会到达 SDK 的自动捕获点。 */
export function captureJobException(error: unknown): void {
  if (!getClient()) return
  const { requestId, workspaceId, userId } = getLogContext()
  captureException(error, { tags: { requestId, workspaceId, userId } })
}

/** 每次 run 独立记录 SDK 已捕获的 step rejection，兼容引擎重新包装原错误。 */
export function createWorkflowSentry<T extends { do: (...args: never[]) => unknown }>(
  step: T,
  sdkEnabled: boolean,
) {
  const captured = new Set<unknown>()
  const trackedStep = new Proxy(step, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      // 原生 step 方法可能是 RPC stub，不能访问其 .bind；用本地闭包保留 receiver。
      if (property !== 'do')
        return typeof value === 'function'
          ? (...args: unknown[]) => Reflect.apply(value, target, args)
          : value
      return async (...args: unknown[]) => {
        const callbackIndex = typeof args[1] === 'function' ? 1 : 2
        const callback = args[callbackIndex] as (...args: unknown[]) => Promise<unknown>
        let sdkCaptured = false
        args[callbackIndex] = async (...callbackArgs: unknown[]) => {
          const context = callbackArgs[0] as
            | { attempt?: number; config?: { retries?: { limit?: number } } }
            | undefined
          // 与安装的 SDK WrappedWorkflowStep 最终尝试判定一致；重试成功时清除标记。
          sdkCaptured = false
          try {
            return await callback(...callbackArgs)
          } catch (error) {
            const attempt = context?.attempt
            const limit = context?.config?.retries?.limit
            sdkCaptured =
              typeof attempt !== 'number' || typeof limit !== 'number' || attempt > limit
            throw error
          }
        }
        try {
          return await Reflect.apply(target.do, target, args)
        } catch (error) {
          // 未执行回调的引擎错误、提前终止的非最终尝试仍需外围捕获。
          if (sdkEnabled && sdkCaptured) captured.add(error)
          throw error
        }
      }
    },
  })
  const observer: JobObserver = {
    tagContext: tagJobContext,
    captureException(error) {
      if (!captured.has(error)) captureJobException(error)
    },
  }
  return { step: trackedStep, observer }
}
