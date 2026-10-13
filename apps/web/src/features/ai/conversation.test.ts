import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import {
  CHAT_ERROR_FALLBACK,
  type ChatUIMessage,
  chatErrorCode,
  chatErrorMessage,
  chatRequestBody,
  streamingMessageId,
  titleFromText,
  toChatMessages,
} from './conversation.ts'

beforeEach(() => overwriteGetLocale(() => 'en'))
afterEach(() => overwriteGetLocale(() => baseLocale))

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

describe('toChatMessages', () => {
  it('只保留用户与助手的文本内容，并带上保存时的状态', () => {
    const messages = toChatMessages([
      { id: id(1), role: 'system', parts: [{ type: 'text', text: 'hidden' }], status: 'completed' },
      { id: id(2), role: 'user', parts: [{ type: 'text', text: 'Hi' }], status: 'completed' },
      {
        id: id(3),
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hel' }, { type: 'reasoning' }, { type: 'text', text: 'lo' }],
        status: 'aborted',
      },
      { id: id(4), role: 'assistant', parts: [], status: 'streaming' },
    ])
    expect(messages).toEqual([
      {
        id: id(2),
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
        metadata: { messageId: id(2), status: 'completed' },
      },
      {
        id: id(3),
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }],
        metadata: { messageId: id(3), status: 'aborted' },
      },
      {
        id: id(4),
        role: 'assistant',
        parts: [],
        metadata: { messageId: id(4), status: 'streaming' },
      },
    ])
  })
})

describe('chatRequestBody', () => {
  it('只提交最后一条用户消息的文本部分', () => {
    const messages: ChatUIMessage[] = [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
      { id: 'c', role: 'user', parts: [{ type: 'text', text: 'second' }] },
    ]
    expect(
      chatRequestBody({ slug: 'u-abc', modelId: id(9), conversationId: id(8), messages }),
    ).toEqual({
      slug: 'u-abc',
      modelId: id(9),
      conversationId: id(8),
      message: { role: 'user', parts: [{ type: 'text', text: 'second' }] },
    })
  })
})

describe('streamingMessageId', () => {
  it('取最后一条助手消息 start 事件中的 messageId', () => {
    const user: ChatUIMessage = { id: 'u', role: 'user', parts: [] }
    const started: ChatUIMessage = {
      id: 'x',
      role: 'assistant',
      parts: [],
      metadata: { messageId: id(5) },
    }
    expect(streamingMessageId([user], 'submitted')).toBeUndefined()
    expect(streamingMessageId([user, started], 'streaming')).toBe(id(5))
  })

  it('start 事件后、首个输出前（仍为 submitted）也返回 id，结束后不返回', () => {
    const started: ChatUIMessage = {
      id: 'x',
      role: 'assistant',
      parts: [],
      metadata: { messageId: id(5) },
    }
    expect(streamingMessageId([started], 'submitted')).toBe(id(5))
    expect(streamingMessageId([started], 'ready')).toBeUndefined()
    expect(streamingMessageId([started], 'error')).toBeUndefined()
  })
})

describe('chat errors', () => {
  it('从非 2xx 响应正文中读取错误码并给出可读提示', () => {
    const error = new Error(
      JSON.stringify({ error: { code: 'AI_PROVIDER_NOT_CONFIGURED', message: 'x' } }),
    )
    expect(chatErrorCode(error)).toBe('AI_PROVIDER_NOT_CONFIGURED')
    expect(chatErrorMessage('AI_PROVIDER_NOT_CONFIGURED')).toContain('not set up')
    for (const code of [
      'INSUFFICIENT_CREDITS',
      'CREDIT_DEBT',
      'RATE_LIMITED',
      'UPGRADE_REQUIRED',
      'MODEL_UNAVAILABLE',
    ])
      expect(chatErrorMessage(code)).not.toBe(CHAT_ERROR_FALLBACK)
  })

  it('无法识别的错误使用通用提示', () => {
    expect(chatErrorCode(new Error('Failed to fetch'))).toBeUndefined()
    expect(chatErrorMessage(undefined)).toBe(CHAT_ERROR_FALLBACK)
    expect(chatErrorMessage('SOMETHING_NEW')).toBe(CHAT_ERROR_FALLBACK)
  })
})

describe('titleFromText', () => {
  it('合并空白并截断到标题长度', () => {
    expect(titleFromText('  hello\n\n world ')).toBe('hello world')
    expect(titleFromText('x'.repeat(200))).toHaveLength(80)
  })
})
