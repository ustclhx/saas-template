/** wrangler.jsonc 中声明的绑定（`import { env } from 'cloudflare:workers'` 与各 handler 的 env 类型） */
declare namespace Cloudflare {
  interface Env {
    /** 不带查询缓存（app-db）：Cron 写库 */
    HYPERDRIVE: Hyperdrive
    /** 带查询缓存（app-db-cached） */
    HYPERDRIVE_CACHED: Hyperdrive
    AI_MEDIA_WORKFLOW: Workflow<import('./workflows/ai-media.ts').AiMediaParams>
  }
}
