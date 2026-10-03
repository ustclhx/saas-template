/** 构建时由 vite.config.ts 从 package.json 注入 */
declare const __APP_VERSION__: string

/** wrangler.jsonc 中声明的绑定（`import { env } from 'cloudflare:workers'` 的类型） */
declare namespace Cloudflare {
  interface Env {
    /** 不带查询缓存（app-db）：健康检查与写操作 */
    HYPERDRIVE: Hyperdrive
    /** 带查询缓存（app-db-cached）：可容忍短暂旧数据的读 */
    HYPERDRIVE_CACHED: Hyperdrive
    /** 定义在 apps/jobs 的 AiMediaWorkflow（script_name: jobs）；参数类型在 P4 移入 packages/ai */
    AI_MEDIA_WORKFLOW: Workflow<{ taskId: string }>
    /** 邮件队列 producer，apps/jobs 消费 */
    EMAIL_QUEUE: Queue<unknown>
  }
}
