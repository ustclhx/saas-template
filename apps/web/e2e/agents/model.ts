import type { LanguageModel } from 'ai'
import { APPROVAL_TOOL } from './project.ts'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type CallOptions = Parameters<Model['doStream']>[0]
type StreamPart =
  Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never

export const MULTI_STEP = 'Run both workspace tools'
export const APPROVE = 'Approve the fixture note'
export const DENY = 'Deny the fixture note'
export const STOP = 'Stop the long reply'
export const RESUME = 'Resume the long reply'
export const PARTIAL = 'The reply is still streaming.'
export const TAIL = 'The reply finished after reconnect.'

function finish(toolCall: boolean): StreamPart {
  return {
    type: 'finish',
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    finishReason: { unified: toolCall ? 'tool-calls' : 'stop', raw: undefined },
  }
}

function currentTurn(prompt: CallOptions['prompt']) {
  const userIndex = prompt.findLastIndex((message) => message.role === 'user')
  const user = prompt[userIndex]
  const text =
    user?.role === 'user'
      ? user.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      : ''
  const results = prompt
    .slice(userIndex + 1)
    .flatMap((message) =>
      message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : [],
    )
  return { text, results }
}

function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, 30_000)
    if (signal?.aborted) done()
    else signal?.addEventListener('abort', done, { once: true })
  })
}

export const model: Model = {
  specificationVersion: 'v4',
  provider: 'agents-e2e',
  modelId: 'agents-e2e',
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error('Agents e2e model only supports streaming')),
  async doStream({ prompt, abortSignal, tools }) {
    const { text, results } = currentTurn(prompt)
    const toolName =
      text === MULTI_STEP
        ? ['current_time', 'list_workspace_files'][results.length]
        : text === STOP && results.length === 0
          ? 'current_time'
          : (text === APPROVE || text === DENY) && results.length === 0
            ? APPROVAL_TOOL
            : undefined
    if (toolName && !tools?.some((tool) => tool.name === toolName))
      throw new Error(`Missing fixture tool: ${toolName}`)

    const reply = (() => {
      if (text === MULTI_STEP) return 'Both workspace tools returned results.'
      if (text === STOP || text === RESUME) return PARTIAL
      const output = results.at(-1)?.output
      // AI SDK 在供应商调用边界把拒绝结果转为 error-text。
      if (output?.type === 'error-text' && output.value === 'Tool call execution denied.')
        return 'The tool was denied.'
      if (output?.type === 'json' && JSON.stringify(output.value).includes('savedNote'))
        return 'The approved tool returned the note.'
      return 'Unexpected scripted model input.'
    })()

    const stream = new ReadableStream<StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        if (toolName) {
          controller.enqueue({
            type: 'tool-call',
            toolCallId: crypto.randomUUID(),
            toolName,
            input: JSON.stringify(toolName === APPROVAL_TOOL ? { note: text } : {}),
          })
        } else {
          controller.enqueue({ type: 'text-start', id: 'reply' })
          controller.enqueue({ type: 'text-delta', id: 'reply', delta: reply })
          if (text === STOP || text === RESUME) {
            await pause(abortSignal)
            if (abortSignal?.aborted) return
            controller.enqueue({ type: 'text-delta', id: 'reply', delta: ` ${TAIL}` })
          }
          controller.enqueue({ type: 'text-end', id: 'reply' })
        }
        controller.enqueue(finish(Boolean(toolName)))
        controller.close()
      },
    })
    return { stream }
  },
}
