import { asSchema } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  type AgentToolContext,
  defineAgentTool,
  isPendingTaskOutput,
  pendingTaskOutput,
  toAiSdkTool,
} from './tool.ts'

describe('defineAgentTool', () => {
  it.each(['', 'Generate_image', 'generate-image', '1_tool', 'generate__image', 'tool_'])(
    '拒绝不符合 snake_case 的工具名 %j',
    (name) => {
      expect(() =>
        defineAgentTool({
          name,
          description: '示例工具',
          input: z.object({}),
          execute: async () => ({}),
        }),
      ).toThrow('expected snake_case')
    },
  )
})

describe('toAiSdkTool', () => {
  it('用 Zod 校验 SDK 输入，按每次工具调用注入上下文', async () => {
    type Context = AgentToolContext<{ name: string }, { enabled: boolean }>
    const input = z.object({ count: z.number().int().positive() })
    const needsApproval = ({ count }: z.output<typeof input>) => count > 1
    const execute = vi.fn(async ({ count }: z.output<typeof input>, { db }: Context) => ({
      name: db.name,
      count,
    }))
    const definition = defineAgentTool({
      name: 'example_tool',
      description: '示例工具',
      input,
      needsApproval,
      execute,
    })
    const context = {
      workspaceId: 'workspace',
      userId: 'user',
      conversationId: 'conversation',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      db: { name: 'example' },
      services: { enabled: true },
    }
    const tool = toAiSdkTool(definition, ({ toolCallId, abortSignal }) => ({
      ...context,
      idempotencyKey: `turn:${toolCallId}`,
      signal: abortSignal,
    }))

    const schema = asSchema(tool.inputSchema)
    expect(await schema.jsonSchema).toMatchObject({
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    })
    expect(await schema.validate?.({ count: 0 })).toMatchObject({ success: false })
    expect(await schema.validate?.({ count: 2 })).toEqual({ success: true, value: { count: 2 } })
    expect(tool.description).toBe(definition.description)
    expect(tool.needsApproval).toBe(needsApproval)
    const signal = new AbortController().signal
    await expect(
      tool.execute({ count: 2 }, { toolCallId: 'call', abortSignal: signal }),
    ).resolves.toEqual({
      name: 'example',
      count: 2,
    })
    expect(execute).toHaveBeenCalledWith(
      { count: 2 },
      { ...context, idempotencyKey: 'turn:call', signal },
    )
  })
})

describe('pendingTaskOutput', () => {
  it('只把带 taskId 的 pending 输出识别为待完成任务', () => {
    expect(pendingTaskOutput('t1', 'image')).toEqual({
      taskId: 't1',
      status: 'pending',
      kind: 'image',
    })
    expect(isPendingTaskOutput(pendingTaskOutput('t1'))).toBe(true)
    expect(isPendingTaskOutput({ taskId: 't1', status: 'succeeded' })).toBe(false)
    expect(isPendingTaskOutput({ taskId: '', status: 'pending' })).toBe(false)
    expect(isPendingTaskOutput('pending')).toBe(false)
  })
})
