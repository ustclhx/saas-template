/**
 * 轮次摘要（`ai_agent_turn` → 页面）：列表的「最近一轮状态」与对话页回答下方的「本轮 N 步 · 消耗 X 积分」。
 * 只含审计与结算字段，不含消息正文、工具参数与输出（决策 6）。纯数据与纯函数，服务端函数与组件共用。
 */

export type AgentTurnStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'expired'

export interface AgentTurnView {
  readonly id: string
  readonly status: AgentTurnStatus
  readonly steps: number
  readonly creditsCharged: number
  readonly modelKey: string
  readonly errorCode: string | null
  /** 执行中的轮次停在等待用户确认（工具调用记录中有等待确认项） */
  readonly awaitingApproval: boolean
}

/** 列表与对话页展示的轮次状态；`none` 为还没有开始任何一轮 */
export type AgentTurnPhase = 'none' | 'awaiting' | AgentTurnStatus

export function turnPhase(turn: AgentTurnView | null | undefined): AgentTurnPhase {
  if (!turn) return 'none'
  if (turn.status === 'running' && turn.awaitingApproval) return 'awaiting'
  return turn.status
}

/**
 * 工具调用记录中表示「等待确认」的状态。`tool_calls` 由轮次服务（4.x / 5.3）写入，只记工具名、状态与耗时；
 * 接口假设：等待确认的调用以 AI SDK 的部件状态名 `approval-requested`（或 `awaiting_approval`）记录。
 */
const AWAITING_STATUSES = new Set(['approval-requested', 'awaiting_approval'])

export function hasAwaitingApproval(
  toolCalls: readonly { readonly status: string }[] | null | undefined,
): boolean {
  return (toolCalls ?? []).some((call) => AWAITING_STATUSES.has(call.status))
}

/** 数据库行 → 摘要（`tool_calls` 只用于判断是否在等待确认，不下发） */
export function toTurnView(row: {
  id: string
  status: AgentTurnStatus
  steps: number
  creditsCharged: number
  modelKey: string
  errorCode: string | null
  toolCalls: readonly { readonly status: string }[] | null
}): AgentTurnView {
  return {
    id: row.id,
    status: row.status,
    steps: row.steps,
    creditsCharged: row.creditsCharged,
    modelKey: row.modelKey,
    errorCode: row.errorCode,
    awaitingApproval: row.status === 'running' && hasAwaitingApproval(row.toolCalls),
  }
}
