import type { AgentToolContext } from '@saas/ai'
import type { Database } from '@saas/db'
import type { Capability, RateLimiter, Workflow } from '@saas/platform'

/**
 * 工具在对话实例（Durable Object）中可用的服务，由 worker/agent.ts 按 Worker 绑定装配。
 * 与 web 插件契约的 `AgentToolServices` 同形（插件经契约取类型；这里不引用 @web，便于插件独立类型检查）。
 */
export interface AgentToolServices {
  /** Worker 的绑定与变量（只读）：工具只读取自己需要的密钥与绑定 */
  readonly env: Readonly<Record<string, unknown>>
  /** 插件 Worker 入口提供的 AI 任务工作流（如 media 的 AI_MEDIA_WORKFLOW） */
  readonly aiWorkflow: Capability<Workflow<{ taskId: string }>>
  readonly rateLimiter: RateLimiter
}

/** 工具执行上下文；`services` 只在对话实例中提供，测试中可缺省 */
export type AgentExecutionContext = AgentToolContext<Database, AgentToolServices | undefined>

export type AgentToolResolutionContext = Omit<AgentExecutionContext, 'idempotencyKey'> & {
  /** 使用 PG 轮次 ID，确认与恢复续轮的 SDK requestId 会变化。 */
  readonly turnId: string
}
