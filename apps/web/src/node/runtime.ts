import { parseAuthEnv } from '@saas/auth'
import { loadNodeEnv } from '@saas/config/node'
import { createDb, type Database } from '@saas/db'
import type { KeyValueStore, RequestMetadata } from '@saas/platform'
import {
  createNodeBackgroundTasks,
  createNodeCache,
  createNodeRequestMetadata,
  unavailableTaskCapabilities,
} from '@saas/platform/node'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { APIError } from 'better-auth/api'
import { handleAuthRequest } from '../features/admin/impersonation-http.ts'
import { createBillingDeletionSteps } from '../features/billing/deletion.server.ts'
import { assertSignupAdmission } from '../features/growth/service.ts'
import { createWebAuth } from '../server/auth.ts'
import type { WebRuntime } from '../server/runtime.ts'
import { templateConfig } from '../server/template-config.ts'

function unavailable(): never {
  throw new AppError('CAPABILITY_UNAVAILABLE', 'Capability is unavailable', { status: 503 })
}

/** 只供构建进程导入的 preview 使用：公开页 getter 失败走已有降级，不建立连接或读取密钥。 */
export function prerenderRuntime(requestMeta: RequestMetadata): WebRuntime {
  return {
    config: {
      APP_URL: templateConfig.app.url,
      BETTER_AUTH_SECRET: '',
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      TURNSTILE_SECRET_KEY: undefined,
    },
    requestMeta,
    cache: { get: unavailable, put: unavailable, delete: unavailable },
    rateLimiter: { limit: unavailable },
    emailQueue: { available: false },
    eventsQueue: { available: false },
    files: { available: false },
    ai: { available: false },
    get db() {
      return unavailable()
    },
    get publicDb() {
      return unavailable()
    },
    get auth() {
      return unavailable()
    },
    createAuth: unavailable,
    handleAuthRequest: unavailable,
  }
}

/** 生产入口在 listen 前装配一次；请求引用进程 facade 并创建认证上下文。 */
export async function createNodeWebProcess() {
  const env = loadNodeEnv({ templateConfig })
  const metadata = createNodeRequestMetadata(env.TRUSTED_PROXY_CIDRS.split(',').filter(Boolean))
  const db = createDb(env.DATABASE_URL, { max: env.DB_POOL_MAX })
  let cache: Awaited<ReturnType<typeof createNodeCache>>
  try {
    cache = await createNodeCache({ url: env.VALKEY_URL, namespace: env.CACHE_NAMESPACE })
  } catch (error) {
    await db.close()
    throw error
  }
  const background = createNodeBackgroundTasks()
  const tasks = unavailableTaskCapabilities()
  const config = {
    ...parseAuthEnv(env, templateConfig),
    TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY,
    PAYMENT_MODE: env.PAYMENT_MODE,
    SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
    ...(env.STRIPE_SECRET_KEY === undefined ? {} : { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }),
    ...(env.STRIPE_WEBHOOK_SECRET === undefined
      ? {}
      : { STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET }),
    ...(env.PAYPAL_CLIENT_ID === undefined ? {} : { PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID }),
    ...(env.PAYPAL_CLIENT_SECRET === undefined
      ? {}
      : { PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET }),
    ...(env.PAYPAL_WEBHOOK_ID === undefined ? {} : { PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID }),
  }
  const requestRuntime = (requestMeta: RequestMetadata): WebRuntime => {
    const authCache = cache.kv('auth')
    const createAuth = (database: Database, secondaryCache: KeyValueStore = authCache) =>
      createWebAuth(config, database, {
        cache: secondaryCache,
        rateLimiter: cache.rateLimiter,
        clientIp: requestMeta.clientIp,
        sendEmail: async () => unavailable(),
        deletionSteps: createBillingDeletionSteps(config, database, authCache),
        beforeUserCreate: async (user, headers) => {
          try {
            await assertSignupAdmission(
              { db: database, config: templateConfig, secret: config.BETTER_AUTH_SECRET },
              user.email,
              headers,
            )
          } catch (error) {
            if (error instanceof AppError)
              throw APIError.from('FORBIDDEN', { code: error.code, message: error.message })
            throw error
          }
        },
      })
    let auth: ReturnType<typeof createAuth> | undefined
    const runtime: WebRuntime = {
      config,
      db,
      publicDb: db,
      cache: cache.kv('settings'),
      rateLimiter: cache.rateLimiter,
      requestMeta,
      observability: { enabled: false, captureError: () => log.error('server.error') },
      emailQueue: tasks.queue,
      eventsQueue: tasks.queue,
      files: { available: false },
      ai: {
        available: true,
        value: {
          config: {
            AI_TEXT_EGRESS: env.AI_TEXT_EGRESS,
            OPENAI_BASE_URL: env.OPENAI_BASE_URL,
            OPENAI_API_KEY: env.OPENAI_API_KEY,
            ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
            GOOGLE_API_KEY: env.GOOGLE_API_KEY,
            DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
            AI_GATEWAY_ACCOUNT_ID: env.AI_GATEWAY_ACCOUNT_ID,
            AI_GATEWAY_ID: env.AI_GATEWAY_ID,
            AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
            ...(env.FAL_KEY === undefined ? {} : { FAL_KEY: env.FAL_KEY }),
          },
          workersAi: { available: false },
          background,
          workflow: { available: false },
          downloadFile: { available: false },
        },
      },
      get auth() {
        auth ??= createAuth(db)
        return auth
      },
      createAuth,
      handleAuthRequest: (request) => handleAuthRequest(request, runtime),
    }
    return runtime
  }
  return {
    env,
    background,
    metadata,
    requestRuntime,
    close: async () => {
      await Promise.all([cache.close(), db.close()])
    },
  }
}
