import { isToolUIPart, type UIMessage } from 'ai'

export const APPROVAL_EXPIRED_ERROR = 'Tool approval expired.'

function approvalTurnRange(messages: readonly UIMessage[], userMessageId: string) {
  const user = messages.findLastIndex(
    (message) => message.role === 'user' && message.id === userMessageId,
  )
  if (user === -1) return { start: 0, end: 0 }

  const start = user + 1
  const nextUser = messages.findIndex((message, index) => index >= start && message.role === 'user')
  return { start, end: nextUser === -1 ? messages.length : nextUser }
}

export function hasPendingApproval(
  messages: readonly UIMessage[],
  userMessageId: string,
  toolCallId?: string,
): boolean {
  const { start, end } = approvalTurnRange(messages, userMessageId)
  return messages
    .slice(start, end)
    .some(
      (message) =>
        message.role === 'assistant' &&
        message.parts.some(
          (part) =>
            isToolUIPart(part) &&
            part.state === 'approval-requested' &&
            (toolCallId === undefined || part.toolCallId === toolCallId),
        ),
    )
}

export function isApprovalExpired(
  hold: { expiresAt: Date | null; status: string },
  now = new Date(),
): boolean {
  return hold.status === 'expired' || (hold.expiresAt !== null && hold.expiresAt <= now)
}

/** 续轮调用模型前或实例唤醒时更新消息，以 persistMessages 持久化，避免 saveMessages 发起新一轮。 */
export function expireTurnApprovals(messages: UIMessage[], userMessageId: string): UIMessage[] {
  const { start, end } = approvalTurnRange(messages, userMessageId)
  let updated: UIMessage[] | undefined
  for (let index = start; index < end; index++) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue

    let changed = false
    const parts = message.parts.map((part): UIMessage['parts'][number] => {
      if (!isToolUIPart(part)) return part
      if (part.state !== 'approval-requested' && part.state !== 'approval-responded') return part

      // 续轮前可能已经写入批准响应。移除审批记录并写入终态工具结果，避免模型重放该调用。
      const { approval: _approval, ...invocation } = part
      changed = true
      return { ...invocation, state: 'output-error', errorText: APPROVAL_EXPIRED_ERROR }
    })
    if (changed) {
      updated ??= messages.slice()
      updated[index] = { ...message, parts }
    }
  }
  return updated ?? messages
}
