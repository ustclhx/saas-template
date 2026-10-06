import type { UIMessage } from 'ai'
import { z } from 'zod'
import type { ChatRequest } from './chat.ts'

/**
 * 对话页的纯函数（tasks.md 3.1）：数据库消息 → `useChat` 消息、每轮请求体、错误提示。
 * 服务端以数据库历史为准，客户端每轮只提交本轮的用户消息（见 `chat.ts` 的 `chatRequestSchema`）。
 */

export type ChatMessageStatus = 'streaming' | 'completed' | 'aborted' | 'failed'

/** 消息元数据：流式回复由 start 事件带上 `conversationId` / `messageId`，历史消息带保存时的状态 */
export interface ChatUIMetadata {
  readonly conversationId?: string
  readonly messageId?: string
  readonly status?: ChatMessageStatus
}

export type ChatUIMessage = UIMessage<ChatUIMetadata>

/** 对话标题的最大长度；新建对话标题为空，首轮回复完成后取首条消息 */
export const CONVERSATION_TITLE_LENGTH = 80
export const conversationTitleSchema = z.string().trim().min(1).max(CONVERSATION_TITLE_LENGTH)

export const conversationTitle = (title: string) => title || 'New chat'

export const titleFromText = (text: string) =>
  text.trim().replace(/\s+/g, ' ').slice(0, CONVERSATION_TITLE_LENGTH)

const textPart = z.object({ type: z.literal('text'), text: z.string() })

/** 数据库中 `parts` 的文本部分（首版对话只有文本） */
export const textParts = (parts: readonly unknown[]) =>
  parts.flatMap((part) => {
    const parsed = textPart.safeParse(part)
    return parsed.success ? [{ type: 'text' as const, text: parsed.data.text }] : []
  })

const textOf = (parts: readonly unknown[]) =>
  textParts(parts)
    .map((part) => part.text)
    .join('')

export const messageText = (message: Pick<UIMessage, 'parts'>) => textOf(message.parts)

/** 数据库中的消息行（`getConversation` 的返回项） */
export interface StoredMessage {
  readonly id: string
  readonly role: string
  readonly parts: readonly unknown[]
  readonly status: ChatMessageStatus
}

/** 只保留用户与助手的文本内容；还在生成或已停止的回复保留已生成部分并带上状态 */
export function toChatMessages(rows: readonly StoredMessage[]): ChatUIMessage[] {
  return rows.flatMap((row) => {
    if (row.role !== 'user' && row.role !== 'assistant') return []
    const text = textOf(row.parts)
    if (!text && row.role === 'user') return []
    return [
      {
        id: row.id,
        role: row.role,
        parts: text ? [{ type: 'text' as const, text }] : [],
        metadata: { messageId: row.id, status: row.status },
      },
    ]
  })
}

/** 每轮请求体：只发送最后一条用户消息的文本部分 */
export function chatRequestBody(input: {
  slug: string
  modelId: string
  conversationId: string
  messages: readonly UIMessage[]
}): ChatRequest {
  const last = input.messages.findLast((message) => message.role === 'user')
  const parts = (last?.parts ?? []).flatMap((part) =>
    part.type === 'text' && part.text ? [{ type: 'text' as const, text: part.text }] : [],
  )
  return {
    slug: input.slug,
    modelId: input.modelId,
    conversationId: input.conversationId,
    message: { role: 'user', parts },
  }
}

/** 正在生成的助手消息 id（停止接口需要），取自 start 事件的 metadata */
export function streamingMessageId(messages: readonly ChatUIMessage[]): string | undefined {
  const last = messages.at(-1)
  return last?.role === 'assistant' ? last.metadata?.messageId : undefined
}

const CHAT_ERRORS: Record<string, string> = {
  INSUFFICIENT_CREDITS: 'Not enough credits for this message. Top up your credits to continue.',
  CREDIT_DEBT: 'Your workspace has unpaid credit debt. Settle it on the Billing page to continue.',
  RATE_LIMITED: 'Too many messages. Please wait a moment and try again.',
  UPGRADE_REQUIRED: 'This model is not included in your plan. Upgrade to use it.',
  MODEL_UNAVAILABLE: 'This model is not available. Choose another model.',
  AI_PROVIDER_NOT_CONFIGURED: 'AI replies are not set up on this server yet. Please try later.',
  INPUT_TOO_LONG: 'This message is too long for the selected model.',
  WORKSPACE_READ_ONLY: 'This workspace is read-only.',
  NOT_FOUND: 'This conversation is no longer available.',
  INVALID_REQUEST: 'This message could not be sent. Check it and try again.',
}

export const CHAT_ERROR_FALLBACK = 'Something went wrong. Please try again.'

export function chatErrorMessage(code: string | undefined): string {
  return (code && CHAT_ERRORS[code]) || CHAT_ERROR_FALLBACK
}

const errorBody = z.object({ error: z.object({ code: z.string() }) })

/** API 错误码：`useChat` 把非 2xx 响应的正文作为 Error 的 message */
export function chatErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  try {
    const parsed = errorBody.safeParse(JSON.parse(error.message))
    return parsed.success ? parsed.data.error.code : undefined
  } catch {
    return undefined
  }
}

/**
 * 停止接口（`POST /api/ai/chat/:messageId/stop`）的响应：已结束的消息幂等返回当前状态，
 * 先前已因出错结束时为 `failed`
 */
export const stopResponseSchema = z.object({ status: z.enum(['aborted', 'completed', 'failed']) })
