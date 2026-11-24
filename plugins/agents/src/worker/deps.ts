import { defaultLanguageModelFactory, type TextModelEnv } from '@saas/ai'
import { createCloudflareDatabase, createCloudflareRateLimiter } from '@saas/platform/cloudflare'
import templateConfig from '../../../../template.config.ts'
import { agentsConfig } from './config.ts'
import type { AgentTurnDeps } from './runner.ts'
import { createSpikeModel } from './spike-model.ts'

// Durable Object 内的依赖装配（openspec add-ai-agents 任务 4.3）。实例不在 web 的请求运行时中，
// 按每次调用从绑定创建数据库客户端与限流器；不放模块级变量（决策 11）。

/** 实例用到的绑定与变量（web wrangler 中已声明，类型见 apps/web/src/env.d.ts） */
export interface AgentEnv extends TextModelEnv {
  readonly HYPERDRIVE: Hyperdrive
  readonly HYPERDRIVE_CACHED: Hyperdrive
  readonly RL_AI?: RateLimit
  readonly AI?: unknown
  readonly SENTRY_ENVIRONMENT?: string
  /** 仅本地开发：`1` 时所有 agent 轮次改用脚本化测试替身模型（不访问外部服务，用于 e2e） */
  readonly AGENTS_SCRIPTED_MODEL?: string
}

export function createAgentTurnDeps(
  env: AgentEnv,
  captureError: AgentTurnDeps['captureError'],
): AgentTurnDeps {
  const db = createCloudflareDatabase(env).business()
  const modelEnv: TextModelEnv = {
    ...env,
    // 与 web 运行时一致：Cloudflare 默认经 AI Gateway 出站
    AI_TEXT_EGRESS: env.AI_TEXT_EGRESS ?? 'gateway',
  }
  return {
    db,
    rateLimiter: createCloudflareRateLimiter(env),
    pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
    workersAi: env.AI !== undefined,
    multiTenant: templateConfig.tenancy.multiTenant,
    overage: templateConfig.billing.overage,
    failedReplyRefund: templateConfig.ai.text.failedReplyRefund,
    maxSteps: agentsConfig.maxSteps,
    maxTurnCredits: agentsConfig.maxTurnCredits,
    languageModel:
      env.SENTRY_ENVIRONMENT === 'development' && env.AGENTS_SCRIPTED_MODEL === '1'
        ? () => createSpikeModel()
        : (model) => defaultLanguageModelFactory(model, modelEnv),
    captureError,
  }
}
