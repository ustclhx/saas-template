import { type AgentToolContext, defineAgentTool, toAiSdkTool } from '@saas/ai'
import { applyToolUpdate, reconcileMessages, toolApprovalUpdate } from 'agents/chat'
import {
  convertToModelMessages,
  isToolUIPart,
  simulateReadableStream,
  stepCountIs,
  streamText,
  type UIMessage,
} from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  APPROVAL_EXPIRED_ERROR,
  expireTurnApprovals,
  hasPendingApproval,
  isApprovalExpired,
} from '../approval.ts'

type ModelStreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part>
    ? Part
    : never

const toolName = 'record_note'
const note = 'test note'
const replyText = 'I received the tool result.'
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

const userMessage: UIMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Record a note.' }],
}

function createApprovalModel() {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const hasToolResult = prompt.at(-1)?.role === 'tool'
      const chunks: ModelStreamPart[] = hasToolResult
        ? [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: replyText },
            { type: 'text-end', id: 'text-1' },
          ]
        : [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify({ note }) }]
      chunks.push({
        type: 'finish',
        finishReason: { unified: hasToolResult ? 'stop' : 'tool-calls', raw: undefined },
        usage,
      })
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

// 使用和 AIChatAgent 相同的消息状态转换，测试无需启动 Durable Object。
function applyApproval(message: UIMessage, toolCallId: string, approved: boolean) {
  const update = applyToolUpdate(message.parts, toolApprovalUpdate(toolCallId, approved))
  return update ? { ...message, parts: update.parts as UIMessage['parts'] } : null
}

async function setupApproval() {
  const model = createApprovalModel()
  const execute = vi.fn(async (_input: { note: string }, _context: AgentToolContext) => ({
    saved: true,
  }))
  const recordNote = defineAgentTool({
    name: toolName,
    description: 'Record a note',
    input: z.object({ note: z.string() }),
    needsApproval: (input) => input.note === note,
    execute,
  })
  const tools = {
    [recordNote.name]: toAiSdkTool(recordNote, ({ toolCallId, abortSignal }) => ({
      workspaceId: 'workspace-1',
      userId: 'account-1',
      conversationId: 'conversation-1',
      idempotencyKey: `turn-1:${toolCallId}`,
      signal: abortSignal,
      db: undefined,
      services: undefined,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })),
  }

  async function run(messages: UIMessage[]) {
    const result = streamText({
      model,
      tools,
      messages: await convertToModelMessages(messages, { tools }),
      stopWhen: stepCountIs(2),
      maxRetries: 0,
      onError: ({ error }) => {
        throw error
      },
    })
    let finalMessages: UIMessage[] = []
    const response = result.toUIMessageStreamResponse({
      originalMessages: messages,
      generateMessageId: () => 'assistant-1',
      onEnd: ({ messages }) => {
        finalMessages = messages
      },
    })
    await response.text()
    return finalMessages
  }

  const messages = await run([userMessage])
  const assistant = messages.at(-1)
  const call = assistant?.parts.find(isToolUIPart)
  if (!assistant || !call) throw new Error('Expected approval request')
  return { run, messages, assistant, callId: call.toolCallId, model, execute }
}

describe('agent 工具审批', () => {
  it('暂停工具执行，收到批准后执行并把结果交给模型', async () => {
    const { run, messages, assistant, callId, model, execute } = await setupApproval()
    expect(hasPendingApproval(messages, userMessage.id, callId)).toBe(true)
    expect(hasPendingApproval(messages, userMessage.id, 'other-call')).toBe(false)
    expect(execute).not.toHaveBeenCalled()

    const approved = applyApproval(assistant, callId, true)
    if (!approved) throw new Error('Expected approval to be applied')

    const reply = await run([userMessage, approved])
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { note },
      expect.objectContaining({ idempotencyKey: `turn-1:${callId}` }),
    )
    expect(model.doStreamCalls.at(-1)?.prompt.at(-1)).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          output: { type: 'json', value: { saved: true } },
        },
      ],
    })
    expect(hasPendingApproval(reply, userMessage.id)).toBe(false)
  })

  it('拒绝后不执行工具，模型收到拒绝结果并继续回复', async () => {
    const { run, assistant, callId, model, execute } = await setupApproval()
    const denied = applyApproval(assistant, callId, false)
    if (!denied) throw new Error('Expected refusal to be applied')

    const reply = await run([userMessage, denied])
    expect(execute).not.toHaveBeenCalled()
    expect(model.doStreamCalls.at(-1)?.prompt.at(-1)).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          output: { type: 'error-text', value: 'Tool call execution denied.' },
        },
      ],
    })
    expect(reply.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: `tool-${toolName}`,
          state: 'output-denied',
          toolCallId: callId,
        }),
        expect.objectContaining({ type: 'text', text: replyText }),
      ]),
    )
  })

  it('到期后标记原轮次，拒绝迟到或已写入的批准响应', async () => {
    const { run, messages, assistant, callId, model, execute } = await setupApproval()
    const expiresAt = new Date('2026-11-24T12:00:00.000Z')
    const before = new Date(expiresAt.getTime() - 1)
    expect(isApprovalExpired({ status: 'running', expiresAt }, before)).toBe(false)
    expect(isApprovalExpired({ status: 'running', expiresAt }, expiresAt)).toBe(true)
    expect(isApprovalExpired({ status: 'expired', expiresAt }, before)).toBe(true)

    const expired = expireTurnApprovals(messages, userMessage.id)
    const expiredAssistant = expired.at(-1)
    if (!expiredAssistant) throw new Error('Expected expired assistant message')
    expect(applyApproval(expiredAssistant, callId, true)).toBeNull()

    const late = applyApproval(assistant, callId, true)
    if (!late) throw new Error('Expected late approval to be applied before expiry check')
    const expiredLate = expireTurnApprovals([userMessage, late], userMessage.id)
    expect(expiredLate).toEqual(expired)

    // 客户端重连时可能重放旧的批准响应。SDK 合并后必须保留服务端终态并跳过执行。
    const replayed = reconcileMessages([userMessage, late], expired)
    expect(replayed.at(-1)?.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-error',
      errorText: APPROVAL_EXPIRED_ERROR,
    })
    await run(replayed)
    expect(execute).not.toHaveBeenCalled()
    expect(model.doStreamCalls.at(-1)?.prompt.at(-1)).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          output: { type: 'error-text', value: APPROVAL_EXPIRED_ERROR },
        },
      ],
    })
  })

  it('工具调用 ID 被模型跨轮复用时，只标记过期轮次中的调用', async () => {
    const { messages, assistant, callId } = await setupApproval()
    const nextUser = { ...userMessage, id: 'user-2' }
    const nextAssistant = { ...assistant, id: 'assistant-2' }
    const updated = expireTurnApprovals([...messages, nextUser, nextAssistant], userMessage.id)

    expect(hasPendingApproval(updated, userMessage.id, callId)).toBe(false)
    expect(hasPendingApproval(updated, nextUser.id, callId)).toBe(true)
    expect(updated.at(-1)).toBe(nextAssistant)
  })
})
