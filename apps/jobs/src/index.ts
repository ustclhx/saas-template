// 后台 Worker 入口：导出 Workflow 类与 fetch / queue / scheduled 处理器（docs/02-project-structure.md）。
// 队列消息的请求 ID 由各消费者按消息恢复（queues/*）；Cron 每次触发生成新的请求 ID。
import { emailTransportConfig } from '@saas/config'
import { newRequestId, withLogContext } from '@saas/shared/log'
import { withSentry } from '@sentry/cloudflare'
import './ai.ts'
import {
  BILLING_DAILY_CRON,
  BILLING_HOURLY_CRON,
  BILLING_RETRY_CRON,
  runBillingSchedule,
} from './billing.ts'
import { runDeletionCleanup } from './cron/deletion-cleanup.ts'
import { runFilesCleanup } from './cron/files-cleanup.ts'
import { HEARTBEAT_CRON, runHeartbeat } from './cron/heartbeat.ts'
import { runMetricsDaily } from './cron/metrics-daily.ts'
import { runWorkspaceCleanup, WORKSPACE_CLEANUP_CRON } from './cron/workspace-cleanup.ts'
import { requireEnv } from './env.ts'
import { handleBillingBatch } from './queues/billing.ts'
import { handleEmailBatch } from './queues/email.ts'
import { sentryEnabled, sentryOptions, tagJobContext } from './sentry.ts'

export { AiMediaWorkflow } from './workflows/ai-media.ts'

// 各环境的队列名（wrangler.jsonc：本地 email，staging email-staging）
const EMAIL_QUEUES = new Set(['email', 'email-staging'])
const EVENTS_QUEUES = new Set(['events', 'events-staging'])

const handler = {
  // jobs 不对外提供 HTTP 接口
  async fetch(_request, env, _ctx?: ExecutionContext) {
    tagJobContext()
    requireEnv(env)
    return new Response('Not Found', { status: 404 })
  },

  queue(batch, env, _ctx?: ExecutionContext) {
    return withLogContext({ queue: batch.queue }, () => consume(batch, env))
  },

  scheduled(controller, env, _ctx?: ExecutionContext) {
    return schedule(controller, env)
  },
} satisfies ExportedHandler<Cloudflare.Env>

// SDK 会原地包装 handler；副本避免禁用路径也进入 SDK 初始化。
const instrumented = withSentry(sentryOptions, { ...handler })

export default {
  fetch(request, env, ctx?: ExecutionContext) {
    return withLogContext({ requestId: newRequestId() }, () => {
      const active = sentryEnabled(env) ? instrumented : handler
      return active.fetch(request, env, ctx)
    })
  },
  queue(batch, env, ctx?: ExecutionContext) {
    return withLogContext({ requestId: newRequestId(), queue: batch.queue }, () => {
      const active = sentryEnabled(env) ? instrumented : handler
      return active.queue(batch, env, ctx)
    })
  },
  scheduled(controller, env, ctx?: ExecutionContext) {
    return withLogContext({ requestId: newRequestId(), cron: controller.cron }, () => {
      const active = sentryEnabled(env) ? instrumented : handler
      return active.scheduled(controller, env, ctx)
    })
  },
} satisfies ExportedHandler<Cloudflare.Env>

async function consume(batch: MessageBatch<unknown>, env: Cloudflare.Env) {
  tagJobContext()
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
  tagJobContext()
  const validEnv = requireEnv(env)
  switch (controller.cron) {
    case BILLING_HOURLY_CRON:
    case BILLING_DAILY_CRON:
      return runBillingSchedule(controller.cron, { ...validEnv, ...env })
    case BILLING_RETRY_CRON: {
      // 文件清理与计费补偿独立执行；任何一项失败仍将本次 Cron 标记为失败。
      const results = await Promise.allSettled([
        runBillingSchedule(controller.cron, { ...validEnv, ...env }),
        runFilesCleanup({ ...validEnv, FILES: env.FILES }),
      ])
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Ten-minute maintenance cron failed',
        )
      return
    }
    // METRICS_DAILY_CRON 与 WORKSPACE_CLEANUP_CRON 是同一个触发器：两项任务独立执行，
    // 任一失败不影响另一项，但仍让本次 Cron 标记为失败。
    case WORKSPACE_CLEANUP_CRON: {
      const results = await Promise.allSettled([
        runWorkspaceCleanup(validEnv),
        runMetricsDaily(validEnv, controller.scheduledTime),
      ])
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Daily maintenance cron failed',
        )
      return
    }
    case HEARTBEAT_CRON:
      await runDeletionCleanup({ ...validEnv, CACHE: env.CACHE })
      return runHeartbeat(validEnv)
    default:
      throw new Error(`Unknown cron: ${controller.cron}`)
  }
}
