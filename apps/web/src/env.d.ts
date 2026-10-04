/** 构建时由 vite.config.ts 从 package.json 注入 */
declare const __APP_VERSION__: string

/** wrangler.jsonc 中声明的绑定（`import { env } from 'cloudflare:workers'` 的类型） */
declare namespace Cloudflare {
  type PaymentEnv = import('@saas/billing').PaymentRuntimeEnv
  interface Env extends PaymentEnv {
    /** 不带查询缓存（app-db）：健康检查与写操作 */
    HYPERDRIVE: Hyperdrive
    /** 带查询缓存（app-db-cached）：可容忍短暂旧数据的读 */
    HYPERDRIVE_CACHED: Hyperdrive
    /** 定义在 apps/jobs 的 AiMediaWorkflow（script_name: jobs）；参数类型在 P4 移入 packages/ai */
    AI_MEDIA_WORKFLOW: Workflow<{ taskId: string }>
    /** 邮件队列 producer，apps/jobs 消费（消息格式见 @saas/email/queue） */
    EMAIL_QUEUE: Queue<import('@saas/email/queue').EmailQueueMessage>
    /** KV：Better Auth 会话的 secondaryStorage（packages/auth/src/session.ts） */
    CACHE: KVNamespace
    /** Rate Limiting：认证入口按 IP + 邮箱限流（packages/auth/src/protection.ts） */
    RL_AUTH: RateLimit
    /** 站点地址（vars；`vite dev` 时由 vite.config.ts 按端口覆盖） */
    APP_URL: string
    /** Turnstile site key（vars，前端公开）；模板配置启用 Turnstile 时必填 */
    TURNSTILE_SITE_KEY?: string
    // 以下为 secrets（wrangler secret / .dev.vars），按模板配置在 checkEnv 中校验
    BETTER_AUTH_SECRET?: string
    TURNSTILE_SECRET_KEY?: string
    GOOGLE_CLIENT_ID?: string
    GOOGLE_CLIENT_SECRET?: string
    GITHUB_CLIENT_ID?: string
    GITHUB_CLIENT_SECRET?: string
  }
}
