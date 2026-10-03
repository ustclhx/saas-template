import { loadEnv, type TemplateConfig } from '@saas/config'
import { z } from 'zod'

/** `createAuth` 读取的环境变量（docs/07-infrastructure.md §4）。 */
export interface AuthEnv {
  readonly BETTER_AUTH_SECRET?: string | undefined
  readonly APP_URL?: string | undefined
  readonly GOOGLE_CLIENT_ID?: string | undefined
  readonly GOOGLE_CLIENT_SECRET?: string | undefined
  readonly GITHUB_CLIENT_ID?: string | undefined
  readonly GITHUB_CLIENT_SECRET?: string | undefined
}

const secret = z.string().min(1)

/**
 * 按模板配置校验认证所需的变量：只有启用的 OAuth 提供方要求对应的 client id / secret。
 * 失败时抛出 `EnvValidationError`（只含变量名，不含取值）。
 */
export function parseAuthEnv(env: AuthEnv, config: TemplateConfig) {
  const oauth = new Set(config.auth.oauth)
  const optional = secret.optional()
  const schema = z.object({
    // Better Auth 要求至少 32 个字符
    BETTER_AUTH_SECRET: z.string().min(32),
    APP_URL: z.url(),
    GOOGLE_CLIENT_ID: oauth.has('google') ? secret : optional,
    GOOGLE_CLIENT_SECRET: oauth.has('google') ? secret : optional,
    GITHUB_CLIENT_ID: oauth.has('github') ? secret : optional,
    GITHUB_CLIENT_SECRET: oauth.has('github') ? secret : optional,
  })
  return loadEnv(env, schema)
}
