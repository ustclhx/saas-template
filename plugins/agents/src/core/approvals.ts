// 续轮是否在处理确认结果（openspec add-ai-agents 决策 5）：与开放轮次记下的待确认调用匹配时，即使步数用尽也再给一步。
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

/**
 * 最后一条用户消息之后已回复确认（approval-responded）的工具调用 id。
 * 消息来自客户端，只用于与开放轮次记下的待确认调用比对，不能单独据此放宽步数。
 */
export function respondedApprovalIds(messages: readonly MessageLike[]): string[] {
  const ids: string[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as MessageLike
    if (message.role === 'user') break
    for (const part of message.parts)
      if (pending(part) && part.state === 'approval-responded') {
        const id = (part as { toolCallId?: unknown }).toolCallId
        if (typeof id === 'string') ids.push(id)
      }
  }
  return ids
}
