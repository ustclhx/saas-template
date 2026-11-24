import type { LanguageModel } from 'ai'

// 技术验证（add-ai-agents 1.1 / 1.2）用的脚本化模型：不访问外部服务，按对话状态决定输出，
// 用量为固定可核对的数字。TODO(4.3)：换成模型注册表解析的真实模型；本文件保留为测试替身。

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>
type CallOptions = Parameters<LanguageModelV4['doStream']>[0]
type StreamPart =
  Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never

/** 每次模型调用的固定用量：输入 100 token，输出 = 文本块数（工具调用步为 10） */
export const SPIKE_INPUT_TOKENS = 100
export const SPIKE_TOOL_OUTPUT_TOKENS = 10

function usage(output: number) {
  return {
    inputTokens: {
      total: SPIKE_INPUT_TOKENS,
      noCache: SPIKE_INPUT_TOKENS,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
  }
}

function lastUserText(prompt: CallOptions['prompt']) {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index]
    if (message?.role !== 'user') continue
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .toLowerCase()
  }
  return ''
}

export interface SpikeModelOptions {
  /** 文本步输出的块数与间隔：用于在流式进行中重启实例 */
  chunks?: number
  chunkDelayMs?: number
  /** 每次 doStream 调用时回调（记录调用次数，观察恢复时是否重放） */
  onCall?: (info: { kind: 'tool' | 'text'; call: number }) => void
}

/**
 * 规则：最后一条是工具结果 → 输出文本；用户消息含 `approve` → 调用需要确认的 `spike_write`；
 * 含 `tool` → 调用 `current_time`；否则直接输出文本。
 */
export function createSpikeModel(options: SpikeModelOptions = {}): LanguageModelV4 {
  const chunks = options.chunks ?? 20
  const delay = options.chunkDelayMs ?? 150
  let calls = 0
  return {
    specificationVersion: 'v4',
    provider: 'spike',
    modelId: 'spike-scripted',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('spike model only supports streaming')),
    async doStream({ prompt, abortSignal }) {
      calls += 1
      const last = prompt.at(-1)
      const text = lastUserText(prompt)
      const toolName =
        last?.role === 'tool'
          ? undefined
          : text.includes('approve')
            ? 'spike_write'
            : text.includes('tool')
              ? 'current_time'
              : undefined
      options.onCall?.({ kind: toolName ? 'tool' : 'text', call: calls })
      const stream = new ReadableStream<StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          if (toolName) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: `call-${crypto.randomUUID()}`,
              toolName,
              input: JSON.stringify(toolName === 'spike_write' ? { note: 'spike' } : {}),
            })
            controller.enqueue({
              type: 'finish',
              usage: usage(SPIKE_TOOL_OUTPUT_TOKENS),
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            })
            controller.close()
            return
          }
          controller.enqueue({ type: 'text-start', id: 't' })
          for (let index = 0; index < chunks; index++) {
            if (abortSignal?.aborted) break
            await new Promise((resolve) => setTimeout(resolve, delay))
            controller.enqueue({ type: 'text-delta', id: 't', delta: `chunk${index} ` })
          }
          controller.enqueue({ type: 'text-end', id: 't' })
          controller.enqueue({
            type: 'finish',
            usage: usage(chunks),
            finishReason: { unified: 'stop', raw: 'stop' },
          })
          controller.close()
        },
      })
      return { stream }
    },
  }
}
