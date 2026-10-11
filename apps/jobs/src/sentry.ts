import { getLogContext, sentryBeforeSend } from '@saas/shared/log'
import {
  type CloudflareOptions,
  captureException,
  getClient,
  getIsolationScope,
} from '@sentry/cloudflare'

export interface SentryEnv {
  SENTRY_DSN?: string
  SENTRY_ENVIRONMENT?: 'development' | 'staging' | 'production'
  APP_VERSION?: string
}

/** 本地即使配置了真实 DSN，也不创建 Sentry client 或发送事件。 */
export function sentryEnabled(env: SentryEnv): boolean {
  return Boolean(
    env.SENTRY_DSN &&
      (env.SENTRY_ENVIRONMENT === 'staging' || env.SENTRY_ENVIRONMENT === 'production'),
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
