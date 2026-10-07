// 后台 Worker 入口：导出 Workflow 类与 fetch / queue / scheduled 处理器（docs/02-project-structure.md）。
// 队列消息的请求 ID 由各消费者按消息恢复（queues/*）；Cron 每次触发生成新的请求 ID。
import { emailTransportConfig } from '@saas/config'
import { newRequestId, withLogContext } from '@saas/shared/log'
import './ai.ts'
import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  runBillingSchedule,
} from './billing.ts'
import { runDeletionCleanup } from './cron/deletion-cleanup.ts'
import { HEARTBEAT_CRON, runHeartbeat } from './cron/heartbeat.ts'
import { runWorkspaceCleanup, WORKSPACE_CLEANUP_CRON } from './cron/workspace-cleanup.ts'
import { requireEnv } from './env.ts'
import { handleBillingBatch } from './queues/billing.ts'
import { handleEmailBatch } from './queues/email.ts'

export { AiMediaWorkflow } from './workflows/ai-media.ts'

// 各环境的队列名（wrangler.jsonc：本地 email，staging email-staging）
const EMAIL_QUEUES = new Set(['email', 'email-staging'])
const EVENTS_QUEUES = new Set(['events', 'events-staging'])

export default {
  // jobs 不对外提供 HTTP 接口
  async fetch(_request, env) {
    requireEnv(env)
    return new Response('Not Found', { status: 404 })
  },

  queue(batch, env) {
    return withLogContext({ queue: batch.queue }, () => consume(batch, env))
  },

  scheduled(controller, env) {
    const context = { requestId: newRequestId(), cron: controller.cron }
    return withLogContext(context, () => schedule(controller, env))
  },
} satisfies ExportedHandler<Cloudflare.Env>

async function consume(batch: MessageBatch<unknown>, env: Cloudflare.Env) {
  const validEnv = requireEnv(env)
  if (EMAIL_QUEUES.has(batch.queue)) {
    return handleEmailBatch(batch, emailTransportConfig(validEnv))
  }
  if (EVENTS_QUEUES.has(batch.queue)) {
    return handleBillingBatch(batch, { ...validEnv, ...env })
  }
  // 未知队列：不确认，交给重试 / 死信队列
  throw new Error(`Unknown queue: ${batch.queue}`)
}

async function schedule(controller: ScheduledController, env: Cloudflare.Env) {
  const validEnv = requireEnv(env)
  switch (controller.cron) {
    case BILLING_HOURLY_CRON:
    case BILLING_RETRY_CRON:
    case BILLING_DAILY_CRON:
      return runBillingSchedule(controller.cron, { ...validEnv, ...env })
    case WORKSPACE_CLEANUP_CRON:
      return runWorkspaceCleanup(validEnv)
    case HEARTBEAT_CRON:
      await runDeletionCleanup({ ...validEnv, CACHE: env.CACHE })
      return runHeartbeat(validEnv)
    default:
      throw new Error(`Unknown cron: ${controller.cron}`)
  }
}
