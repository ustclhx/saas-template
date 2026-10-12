import { z } from 'zod'
import { withEmailEnv } from './email-env.ts'
import type { TemplateConfig } from './template.ts'

const secret = z.string().min(1)

/** 仅标量配置；PAYMENT_MODE 继续由支付入口校验，缺凭据不阻断公开页面。 */
const nodeEnvBaseSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/, hostname: /.+/ }),
  VALKEY_URL: z.url({ protocol: /^rediss?$/, hostname: /.+/ }),
  BETTER_AUTH_SECRET: z.string().min(32),
  APP_URL: z.url({ protocol: /^https$/, hostname: /.+/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  CACHE_NAMESPACE: secret.default('saas'),
  PAYMENT_MODE: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: secret.optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: secret.optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: secret.optional(),
  STRIPE_SECRET_KEY: secret.optional(),
  STRIPE_WEBHOOK_SECRET: secret.optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: secret.optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  AI_TEXT_EGRESS: z.enum(['direct', 'gateway']).default('direct'),
  OPENAI_API_KEY: secret.optional(),
  ANTHROPIC_API_KEY: secret.optional(),
  GOOGLE_API_KEY: secret.optional(),
  DEEPSEEK_API_KEY: secret.optional(),
  FAL_KEY: secret.optional(),
  AI_GATEWAY_ACCOUNT_ID: z.string().optional(),
  AI_GATEWAY_ID: z.string().optional(),
  AI_GATEWAY_TOKEN: secret.optional(),
  RESEND_API_KEY: secret.optional(),
  EMAIL_TRANSPORT: z.enum(['log', 'resend']).default('log'),
  EMAIL_FROM: z.string().optional(),
  EMAIL_REPLY_TO: z.string().optional(),
})

export const nodeEnvSchema = withEmailEnv(nodeEnvBaseSchema)

export type NodeEnv = z.output<typeof nodeEnvSchema>

/** 只允许这些密钥的 _FILE；未知配置不会触发任意文件读取。 */
export const nodeSecretNames = [
  'DATABASE_URL',
  'VALKEY_URL',
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'TURNSTILE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'FAL_KEY',
  'AI_GATEWAY_TOKEN',
  'RESEND_API_KEY',
] as const satisfies readonly (keyof NodeEnv)[]

/** 启动入口传入模板开关；OAuth/Turnstile 仅启用时必填，邮件沿用既有通道约束。 */
export function nodeEnvSchemaFor(config: Pick<TemplateConfig, 'auth'>) {
  const oauth = new Set(config.auth.oauth)
  return withEmailEnv(
    nodeEnvBaseSchema.extend({
      GOOGLE_CLIENT_ID: oauth.has('google') ? secret : secret.optional(),
      GOOGLE_CLIENT_SECRET: oauth.has('google') ? secret : secret.optional(),
      GITHUB_CLIENT_ID: oauth.has('github') ? secret : secret.optional(),
      GITHUB_CLIENT_SECRET: oauth.has('github') ? secret : secret.optional(),
      TURNSTILE_SITE_KEY: config.auth.turnstile ? secret : secret.optional(),
      TURNSTILE_SECRET_KEY: config.auth.turnstile ? secret : secret.optional(),
    }),
  )
}
