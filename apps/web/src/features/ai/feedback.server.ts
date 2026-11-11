import { aiConversation, aiMessage, aiMessageFeedback, type Database, scoped } from '@saas/db'
import { AppError } from '@saas/shared'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import {
  isFeedbackReason,
  type MessageFeedbackValue,
  normalizeFeedbackComment,
} from './feedback.ts'

// 消息评分的数据库读写（add-subject-chat tasks.md 3.2）。只认当前用户自己对话中的助手回复，
// 他人消息与不存在的消息一样返回 404。

const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })

export interface FeedbackScope {
  readonly db: Database
  readonly workspaceId: string
  readonly userId: string
}

/** 一组消息上当前用户的评分（对话页与对象对话初始数据） */
export async function feedbackForMessages(
  scope: FeedbackScope,
  messageIds: readonly string[],
): Promise<Record<string, MessageFeedbackValue>> {
  if (messageIds.length === 0) return {}
  const rows = await scoped(scope.db, scope.workspaceId).select(aiMessageFeedback, {
    fields: {
      messageId: aiMessageFeedback.messageId,
      rating: aiMessageFeedback.rating,
      comment: aiMessageFeedback.comment,
      reason: aiMessageFeedback.reason,
    },
    where: and(
      eq(aiMessageFeedback.userId, scope.userId),
      inArray(aiMessageFeedback.messageId, [...messageIds]),
    ) as SQL,
  })
  return Object.fromEntries(
    rows.map((row) => [
      row.messageId,
      { rating: row.rating, comment: row.comment, reason: row.reason },
    ]),
  )
}

/** 设置、修改或撤销（rating 为 null）评分；返回保存后的值 */
export async function saveMessageFeedback(
  scope: FeedbackScope,
  input: {
    messageId: string
    rating: 'up' | 'down' | null
    comment?: string | undefined
    reason?: string | null | undefined
  },
): Promise<MessageFeedbackValue | null> {
  // 原因只属于点踩：点赞带原因是客户端错误，直接拒绝而不是静默丢弃；撤销时整条记录删除
  const reason = input.reason ?? null
  if (reason !== null && (input.rating !== 'down' || !isFeedbackReason(reason)))
    throw new AppError('INVALID_REQUEST', 'Invalid feedback reason', { status: 400 })
  const s = scoped(scope.db, scope.workspaceId)
  const [message] = await s
    .select(aiMessage, {
      fields: {
        id: aiMessage.id,
        status: aiMessage.status,
        modelKey: aiMessage.modelKey,
        conversationId: aiMessage.conversationId,
      },
      where: and(eq(aiMessage.id, input.messageId), eq(aiMessage.role, 'assistant')) as SQL,
    })
    .limit(1)
  if (!message) throw notFound()
  const [conversation] = await s
    .select(aiConversation, {
      fields: { subjectType: aiConversation.subjectType },
      where: and(
        eq(aiConversation.id, message.conversationId),
        eq(aiConversation.userId, scope.userId),
      ) as SQL,
    })
    .limit(1)
  if (!conversation) throw notFound()

  const own = and(
    eq(aiMessageFeedback.messageId, message.id),
    eq(aiMessageFeedback.userId, scope.userId),
  ) as SQL
  if (input.rating === null) {
    await s.delete(aiMessageFeedback, own)
    return null
  }
  if (message.status === 'streaming')
    throw new AppError('INVALID_REQUEST', 'Reply is still being generated', { status: 409 })
  // 每次保存都写入完整的 reason：切到点赞或点踩时不选原因都会清空旧值
  const value: MessageFeedbackValue = {
    rating: input.rating,
    comment: normalizeFeedbackComment(input.comment),
    reason,
  }
  await s
    .insert(aiMessageFeedback, {
      messageId: message.id,
      userId: scope.userId,
      ...value,
      modelKey: message.modelKey,
      subjectType: conversation.subjectType,
    })
    .onConflictDoUpdate({
      target: [aiMessageFeedback.messageId, aiMessageFeedback.userId],
      set: { ...value, updatedAt: new Date() },
    })
  return value
}
