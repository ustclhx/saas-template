import {
  type AuthEmail,
  type AuthEnv,
  type CreateAuthDeps,
  createAuth,
  type DeletionStep,
  parseAuthEnv,
  type SendAuthEmail,
} from '@saas/auth'
import { grantSignupBonus } from '@saas/billing'
import { createDb, type Database } from '@saas/db'
import type { KeyValueStore, RateLimiter, RequestMetadata } from '@saas/platform'
import { AppError } from '@saas/shared'
import { APIError } from 'better-auth/api'
import { createBillingDeletionSteps } from '../features/billing/deletion.server.ts'
import { assertSignupAdmission } from '../features/growth/service.ts'
import { createQueueAuthEmailSender, userLocaleByEmail } from './auth-email.ts'
import { legacyRequestMetadata } from './runtime.ts'
import { templateConfig } from './template-config.ts'
import { resolveWorkspaceMaxSeats } from './workspace-data.ts'

/**
 * 按请求创建 Better Auth 实例（design.md 决策 1）：每个请求使用该请求的数据库客户端，
 * 不缓存到模块作用域。认证邮件投递到 EMAIL_QUEUE，由 apps/jobs 渲染并按 EMAIL_TRANSPORT 发送
 * （tasks.md 3.2）；用户请求只等待入队。
 * 同一请求中已有数据库客户端时可传入复用（如 withSession、requireFreshSession），避免多建一个连接；否则新建一个。
 */
/** @deprecated A 4.6 移除旧 bindings 接线；新模块使用 getWebRuntime().auth/createWebAuth。 */
export function getAuth(
  env: Cloudflare.Env,
  db: Database = createDb(env.HYPERDRIVE),
  options?: { cache?: KeyValueStore; rateLimiter?: RateLimiter; requestMeta?: RequestMetadata },
) {
  const queued = createQueueAuthEmailSender({
    queue: {
      send: async (message) => {
        await env.EMAIL_QUEUE.send(message, { contentType: 'json' })
      },
    },
    appName: templateConfig.app.name,
    appUrl: env.APP_URL,
    resolveLocale: userLocaleByEmail(db),
  })
  // `vite dev` 下额外打印完整消息，便于本地点击验证链接、查看验证码（jobs 的 log 通道不记录链接与验证码）
  const sendEmail: SendAuthEmail = import.meta.env.DEV
    ? async (email: AuthEmail) => {
        console.log('[dev] auth email', email)
        await queued(email)
      }
    : queued
  // 尚未迁移的调用方保留 CF TTL 与限流语义，能力不再进入 AuthEnv。
  const cache = options?.cache ?? {
    get: env.CACHE.get.bind(env.CACHE),
    put: (key: string, value: string, ttl?: { expirationTtl?: number }) =>
      env.CACHE.put(
        key,
        value,
        ttl?.expirationTtl === undefined
          ? undefined
          : {
              expirationTtl: Math.max(60, ttl.expirationTtl),
            },
      ),
    delete: env.CACHE.delete.bind(env.CACHE),
  }
  const rateLimiter = options?.rateLimiter ?? {
    limit: (_policy: 'auth' | 'ai' | 'api', key: string) => env.RL_AUTH.limit({ key }),
  }
  const requestMeta = options?.requestMeta ?? legacyRequestMetadata()
  return createWebAuth(env, db, {
    cache,
    rateLimiter,
    clientIp: requestMeta?.clientIp ?? null,
    beforeUserCreate: async (user, headers) => {
      try {
        await assertSignupAdmission(
          {
            db,
            config: templateConfig,
            secret: parseAuthEnv(env, templateConfig).BETTER_AUTH_SECRET,
          },
          user.email,
          headers,
        )
      } catch (error) {
        if (error instanceof AppError)
          throw APIError.from('FORBIDDEN', { code: error.code, message: error.message })
        throw error
      }
    },
    deletionSteps: createBillingDeletionSteps(env, db, cache),
    sendEmail,
  })
}

/** @deprecated A 4.6 迁移删除入口后移除旧 bindings 接线。 */
export function billingDeletionSteps(env: Cloudflare.Env, db: Database): DeletionStep[] {
  return createBillingDeletionSteps(env, db, env.CACHE)
}

/** 中立认证工厂；发信、注册准入与删除外部能力由 composition root 注入。 */
export function createWebAuth(config: AuthEnv, db: Database, deps: Omit<CreateAuthDeps, 'config'>) {
  return createAuth(config, db, {
    ...deps,
    config: templateConfig,
    resolveMaxSeats: deps.resolveMaxSeats ?? resolveWorkspaceMaxSeats,
    onEmailVerified:
      deps.onEmailVerified ??
      ((user) => grantSignupBonus({ db, userId: user.id, config: templateConfig.billing })),
  })
}
