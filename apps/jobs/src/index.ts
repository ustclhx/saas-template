// Cloudflare composition entry：绑定、WorkflowEntrypoint 与 Sentry SDK 只在目标入口装配。
// 启用插件的 jobs 入口来自生成文件 plugins.gen.ts：具名导出（Workflow 类）原样导出，
// 队列、定时任务与积分预扣清理器合并到核心注册表。
import { emailTransportConfig } from '@saas/config'
import {
  createCloudflareDatabase,
  createCloudflareKv,
  createCloudflareQueue,
  createCloudflareQueueBatch,
} from '@saas/platform/cloudflare'
import { newRequestId, withLogContext } from '@saas/shared/log'
import { createCloudflareObjectDeleter, createCloudflareStorage } from '@saas/storage/cloudflare'
import { withSentry } from '@sentry/cloudflare'
import templateConfig from '../../../template.config.ts'
import { registerAiHoldSweepers } from './ai.ts'
import { serverAnalyticsTarget } from './billing.ts'
import { requireEnv } from './env.ts'
import { consumeJobsBatch, type JobsContext, runJobsSchedule } from './handlers.ts'
import { registerPluginHoldSweepers } from './plugins/register.ts'
import jobsPlugins from './plugins.gen.ts'
import { createEventsDeadLetterSink } from './queues/events-dead-letter.ts'
import {
  captureJobException,
  createWorkflowSentry,
  sentryEnabled,
  sentryOptions,
  tagJobContext,
} from './sentry.ts'

const cloudflareJobObserver = { tagContext: tagJobContext, captureException: captureJobException }

const features = {
  billing: templateConfig.billing.enabled,
  credits: templateConfig.credits.enabled,
  text: templateConfig.ai.text.enabled,
}
registerAiHoldSweepers(features)
const pluginModules = jobsPlugins.flatMap((plugin) => (plugin.entry ? [plugin.entry] : []))
for (const plugin of pluginModules)
  plugin.configureWorker?.({
    requireEnv,
    tagJobContext,
    createWorkflowSentry,
    sentryEnabled,
    sentryOptions,
  })
registerPluginHoldSweepers(pluginModules, templateConfig)

export * from './plugins.gen.ts'

/** 每事件装配并显式挑选标量配置；不把 bindings 传入业务 env。 */
function createJobsContext(env: Cloudflare.Env, queue?: string): JobsContext {
  const valid = requireEnv(env)
  const shareCards = createCloudflareStorage(env).shareCards
  return {
    config: {
      ...(valid.PAYMENT_MODE === undefined ? {} : { PAYMENT_MODE: valid.PAYMENT_MODE }),
      ...(env.AI_FAULT_INJECTION === undefined
        ? {}
        : { AI_FAULT_INJECTION: env.AI_FAULT_INJECTION }),
      ...(env.SENTRY_ENVIRONMENT === undefined
        ? {}
        : { SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT }),
      ...(env.STRIPE_SECRET_KEY === undefined ? {} : { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }),
      ...(env.STRIPE_WEBHOOK_SECRET === undefined
        ? {}
        : { STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET }),
      ...(env.PAYPAL_CLIENT_ID === undefined ? {} : { PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID }),
      ...(env.PAYPAL_CLIENT_SECRET === undefined
        ? {}
        : { PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET }),
      ...(env.PAYPAL_WEBHOOK_ID === undefined ? {} : { PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID }),
    },
    db: createCloudflareDatabase(env),
    cache: createCloudflareKv(env.CACHE),
    emailQueue: createCloudflareQueue(env.EMAIL_QUEUE),
    ...(env.EVENTS_QUEUE && { eventsQueue: createCloudflareQueue(env.EVENTS_QUEUE) }),
    ...(queue && {
      eventsDeadLetters: createEventsDeadLetterSink(queue, createCloudflareQueue(env.EVENTS_DLQ)),
    }),
    emailTransport: emailTransportConfig(valid),
    ...(shareCards && { shareCards }),
    files: { available: true, value: createCloudflareObjectDeleter(env.FILES) },
    observer: cloudflareJobObserver,
    billingEnabled: features.billing,
    analytics: serverAnalyticsTarget(env),
    plugins: pluginModules,
  }
}

const handler = {
  async fetch(_request, env, _ctx?: ExecutionContext) {
    tagJobContext()
    requireEnv(env)
    return new Response('Not Found', { status: 404 })
  },
  async queue(batch, env, _ctx?: ExecutionContext) {
    return withLogContext({ queue: batch.queue }, () =>
      consumeJobsBatch(createCloudflareQueueBatch(batch), createJobsContext(env, batch.queue)),
    )
  },
  async scheduled(controller, env, _ctx?: ExecutionContext) {
    return runJobsSchedule(
      controller.cron,
      new Date(controller.scheduledTime),
      createJobsContext(env),
      { cronProfile: env.CRON_PROFILE ?? 'default', features },
    )
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
