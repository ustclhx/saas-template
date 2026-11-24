import type { AgentToolContext } from '@saas/ai'
import type { Database } from '@saas/db'

export type AgentExecutionContext = AgentToolContext<Database>

export type AgentToolResolutionContext = Omit<AgentExecutionContext, 'idempotencyKey'> & {
  /** 使用 PG 轮次 ID，确认与恢复续轮的 SDK requestId 会变化。 */
  readonly turnId: string
}
