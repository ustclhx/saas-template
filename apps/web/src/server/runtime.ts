import { AsyncLocalStorage } from 'node:async_hooks'
import type { Auth, parseAuthEnv } from '@saas/auth'
import type { PaymentRuntimeEnv } from '@saas/billing'
import type { Database } from '@saas/db'
import type { EmailQueueMessage } from '@saas/email/queue'
import type {
  Capability,
  KeyValueStore,
  QueueProducer,
  RateLimiter,
  RequestMetadata,
} from '@saas/platform'
import { AppError } from '@saas/shared'
import type { AuthUiEnv } from '../features/auth/options.ts'

/** 请求资源由目标入口装配；业务只读取标量与中立能力，不访问原始 bindings。 */
export interface WebRuntime {
  readonly config: ReturnType<typeof parseAuthEnv> & AuthUiEnv & PaymentRuntimeEnv
  readonly db: Database
  readonly auth: Auth
  readonly cache: KeyValueStore
  readonly rateLimiter: RateLimiter
  readonly requestMeta: RequestMetadata
  readonly emailQueue: Capability<QueueProducer<EmailQueueMessage>>
  readonly eventsQueue: Capability<QueueProducer<unknown>>
  /** 后台认证写入需借用事务 facade 与延后提交的缓存。 */
  createAuth(db: Database, cache?: KeyValueStore): Auth
  handleAuthRequest(request: Request): Promise<Response>
}

const storage = new AsyncLocalStorage<WebRuntime>()

export function withWebRuntime<T>(runtime: WebRuntime, handle: () => T): T {
  return storage.run(runtime, handle)
}

export function getWebRuntime(): WebRuntime {
  const runtime = storage.getStore()
  if (!runtime)
    throw new AppError('RUNTIME_UNAVAILABLE', 'Request runtime is unavailable', { status: 503 })
  return runtime
}

/** @deprecated 仅供 A 4.6 待移除的 getAuth 接线；新业务必须要求请求上下文存在。 */
export function legacyRequestMetadata(): RequestMetadata | undefined {
  return storage.getStore()?.requestMeta
}
