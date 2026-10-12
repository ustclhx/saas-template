import { loadEnv, type TemplateConfig } from '@saas/config'
import { z } from 'zod'
import type { RateLimiter } from './protection.ts'
import type { KvStore } from './session.ts'

/** `createAuth` 读取的环境变量（docs/07-infrastructure.md §4）。 */
export interface AuthEnv {
  readonly BETTER_AUTH_SECRET?: string | undefined
  readonly APP_URL?: string | undefined
  /** 已验证邮箱的首次管理员名单；逗号分隔，空值禁用 */
  readonly BOOTSTRAP_ADMIN_EMAILS?: string | undefined
  readonly GOOGLE_CLIENT_ID?: string | undefined
  readonly GOOGLE_CLIENT_SECRET?: string | undefined
  readonly GITHUB_CLIENT_ID?: string | undefined
  readonly GITHUB_CLIENT_SECRET?: string | undefined
  /** `auth.turnstile=true` 时必填 */
  readonly TURNSTILE_SECRET_KEY?: string | undefined
  /** KV：会话的 secondaryStorage（session.ts）；未提供时会话只用 Cookie 缓存 + 数据库 */
  readonly CACHE?: KvStore | undefined
  /** Rate Limiting：认证入口按 IP + 邮箱限流（protection.ts）；未提供时不限流 */
  readonly RL_AUTH?: RateLimiter | undefined
}

const secret = z.string().min(1)

/**
 * 按模板配置校验认证所需的变量：只有启用的 OAuth 提供方要求对应的 client id / secret，
 * 启用 Turnstile 时要求 `TURNSTILE_SECRET_KEY`。绑定（CACHE、RL_AUTH）不在此校验，由各 app 的 env schema 负责。
 * 失败时抛出 `EnvValidationError`（只含变量名，不含取值）。
 */
export function parseAuthEnv(env: AuthEnv, config: TemplateConfig) {
  const oauth = new Set(config.auth.oauth)
  const optional = secret.optional()
  const schema = z.object({
    // Better Auth 要求至少 32 个字符
    BETTER_AUTH_SECRET: z.string().min(32),
    APP_URL: z.url(),
    BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
    GOOGLE_CLIENT_ID: oauth.has('google') ? secret : optional,
    GOOGLE_CLIENT_SECRET: oauth.has('google') ? secret : optional,
    GITHUB_CLIENT_ID: oauth.has('github') ? secret : optional,
    GITHUB_CLIENT_SECRET: oauth.has('github') ? secret : optional,
    TURNSTILE_SECRET_KEY: config.auth.turnstile ? secret : optional,
  })
  return loadEnv(env, schema)
}
