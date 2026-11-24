// 续轮是否在处理确认结果（openspec add-ai-agents 决策 5）：是则即使步数用尽也再给一步，让模型看到工具结果。
// 过期确认的改写见 src/approval.ts 的 expireTurnApprovals（任务 5.3）。

interface MessageLike {
  readonly role: string
  readonly parts: readonly unknown[]
}

type ToolPart = {
  type: string
  state?: string
  approval?: { id: string; approved?: boolean; reason?: string }
}

const pending = (part: unknown): part is ToolPart & { approval: { id: string } } => {
  if (typeof part !== 'object' || part === null) return false
  const value = part as ToolPart
  return (
    (value.type.startsWith('tool-') || value.type === 'dynamic-tool') &&
    (value.state === 'approval-requested' || value.state === 'approval-responded') &&
    typeof value.approval?.id === 'string'
  )
}

/** 消息中是否有等待处理的确认（用于判断续轮是否在处理确认结果） */
export function hasApprovalResponse(messages: readonly MessageLike[]): boolean {
  const last = messages.at(-1)
  return (
    last?.role === 'assistant' &&
    last.parts.some((part) => pending(part) && (part as ToolPart).state === 'approval-responded')
  )
}
