// 后台 Worker 入口：导出 Workflow 类与 fetch / queue / scheduled 处理器（docs/02-project-structure.md）。
import { HEARTBEAT_CRON, runHeartbeat } from './cron/heartbeat.ts'
import { requireEnv } from './env.ts'
import { handleEmailBatch } from './queues/email.ts'

export { AiMediaWorkflow } from './workflows/ai-media.ts'

export default {
  // jobs 不对外提供 HTTP 接口
  async fetch(_request, env) {
    requireEnv(env)
    return new Response('Not Found', { status: 404 })
  },

  async queue(batch, env) {
    requireEnv(env)
    switch (batch.queue) {
      case 'email':
        return handleEmailBatch(batch)
      default:
        // 未知队列：不确认，交给重试 / 死信队列
        throw new Error(`Unknown queue: ${batch.queue}`)
    }
  },

  async scheduled(controller, env) {
    const validEnv = requireEnv(env)
    switch (controller.cron) {
      case HEARTBEAT_CRON:
        return runHeartbeat(validEnv)
      default:
        throw new Error(`Unknown cron: ${controller.cron}`)
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>
