import { AppError } from '@saas/shared'
import { APICallError } from 'ai'
import { convertReadableStreamToArray, MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { failureKindOfTextError } from '../failover/text-error.ts'
import { fallbackLanguageModel, type TextFallbackEvent } from './fallback.ts'
import { AI_PROVIDER_NOT_CONFIGURED } from './model.ts'

type CallOptions = Parameters<MockLanguageModelV4['doStream']>[0]
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never

const call: CallOptions = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}
const generated = (text: string): GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage,
  warnings: [],
})
const start: StreamPart = { type: 'stream-start', warnings: [] }
const meta: StreamPart = { type: 'response-metadata', id: 'r1', modelId: 'm' }
const textStart: StreamPart = { type: 'text-start', id: 't' }
const delta = (text: string): StreamPart => ({ type: 'text-delta', id: 't', delta: text })
const finish: StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: undefined },
  usage,
}
const apiError = (statusCode?: number) =>
  new APICallError({
    message: `status ${statusCode}`,
    url: 'https://example.test/v1',
    requestBodyValues: {},
    ...(statusCode === undefined ? {} : { statusCode }),
  })
const notConfigured = () =>
  new AppError(AI_PROVIDER_NOT_CONFIGURED, 'Provider is not configured', { status: 503 })

/** 依次吐出分片；分片为 Error 实例时让 read() 抛出。记录是否被取消。 */
function streamOf(parts: Array<StreamPart | Error>) {
  const cancel = vi.fn()
  const stream = new ReadableStream<StreamPart>(
    {
      pull(controller) {
        const part = parts.shift()
        if (part === undefined) controller.close()
        else if (part instanceof Error) controller.error(part)
        else controller.enqueue(part)
      },
      cancel,
    },
    { highWaterMark: 0 },
  )
  return { stream, cancel }
}

function streamModel(id: string, parts: Array<StreamPart | Error>) {
  const { stream, cancel } = streamOf(parts)
  const model = new MockLanguageModelV4({ provider: `p-${id}`, modelId: id, doStream: { stream } })
  return { model, cancel }
}

function failingModel(id: string, error: unknown) {
  return new MockLanguageModelV4({
    provider: `p-${id}`,
    modelId: id,
    doGenerate: async () => {
      throw error
    },
    doStream: async () => {
      throw error
    },
  })
}

describe('文本错误分类', () => {
  it('按 APICallError 状态码归类', () => {
    expect(failureKindOfTextError(apiError(429))).toBe('rate_limited')
    expect(failureKindOfTextError(apiError(401))).toBe('auth')
    expect(failureKindOfTextError(apiError(403))).toBe('auth')
    expect(failureKindOfTextError(apiError(503))).toBe('provider_error')
    expect(failureKindOfTextError(apiError(400))).toBe('rejected_input')
    expect(failureKindOfTextError(apiError(undefined))).toBe('provider_error')
    expect(failureKindOfTextError(notConfigured())).toBe('unavailable')
    expect(failureKindOfTextError(new TypeError('fetch failed'))).toBe('provider_error')
  })
})

describe('fallbackLanguageModel', () => {
  it('连接期 429 切换到下一候选并报告实际模型', async () => {
    const events: TextFallbackEvent[] = []
    const onSelected = vi.fn()
    const backup = streamModel('b', [start, delta('ok'), finish])
    const model = fallbackLanguageModel(
      [
        { key: 'a', create: () => failingModel('a', apiError(429)) },
        { key: 'b', create: () => backup.model },
      ],
      { onFallback: (event) => events.push(event), onSelected },
    )
    const result = await model.doStream(call)
    expect(await convertReadableStreamToArray(result.stream)).toEqual([start, delta('ok'), finish])
    expect(events).toEqual([{ from: 'a', to: 'b', kind: 'rate_limited' }])
    expect(model.selectedKey).toBe('b')
    expect(onSelected).toHaveBeenCalledWith('b')
    // provider / modelId 仍取主候选
    expect(model.provider).toBe('p-a')
    expect(model.modelId).toBe('a')
  })

  it('doGenerate 连接期 5xx 切换', async () => {
    const backup = new MockLanguageModelV4({ doGenerate: generated('from b') })
    const model = fallbackLanguageModel([
      { key: 'a', create: () => failingModel('a', apiError(502)) },
      { key: 'b', create: () => backup },
    ])
    const result = await model.doGenerate(call)
    expect(result.content).toEqual([{ type: 'text', text: 'from b' }])
    expect(model.selectedKey).toBe('b')
  })

  it('流内首个内容分片前的 error 分片切换，并取消原流；非内容分片只保留选中流的', async () => {
    const events: TextFallbackEvent[] = []
    const startB: StreamPart = { type: 'stream-start', warnings: [] }
    const metaB: StreamPart = { type: 'response-metadata', id: 'r2', modelId: 'b' }
    const primary = streamModel('a', [
      start,
      meta,
      textStart,
      { type: 'error', error: apiError(503) },
      delta('never'),
    ])
    const backup = streamModel('b', [startB, metaB, textStart, delta('hello'), finish])
    const model = fallbackLanguageModel(
      [
        { key: 'a', create: () => primary.model },
        { key: 'b', create: () => backup.model },
      ],
      { onFallback: (event) => events.push(event) },
    )
    const result = await model.doStream(call)
    const parts = await convertReadableStreamToArray(result.stream)
    expect(parts).toEqual([startB, metaB, textStart, delta('hello'), finish])
    expect(parts.filter((part) => part.type === 'stream-start')).toHaveLength(1)
    expect(primary.cancel).toHaveBeenCalled()
    expect(events).toEqual([{ from: 'a', to: 'b', kind: 'provider_error' }])
  })

  it('流内首个内容分片前的流异常切换', async () => {
    const primary = streamModel('a', [start, new TypeError('network lost')])
    const backup = streamModel('b', [start, delta('hello'), finish])
    const model = fallbackLanguageModel([
      { key: 'a', create: () => primary.model },
      { key: 'b', create: () => backup.model },
    ])
    const result = await model.doStream(call)
    expect(await convertReadableStreamToArray(result.stream)).toEqual([
      start,
      delta('hello'),
      finish,
    ])
    expect(model.selectedKey).toBe('b')
  })

  it('首个内容分片之后的错误原样透传，不切换', async () => {
    const create = vi.fn(() => streamModel('b', [start, delta('b'), finish]).model)
    const error: StreamPart = { type: 'error', error: apiError(503) }
    const primary = streamModel('a', [start, meta, delta('partial'), error, finish])
    const model = fallbackLanguageModel([
      { key: 'a', create: () => primary.model },
      { key: 'b', create },
    ])
    const result = await model.doStream(call)
    expect(await convertReadableStreamToArray(result.stream)).toEqual([
      start,
      meta,
      delta('partial'),
      error,
      finish,
    ])
    expect(model.selectedKey).toBe('a')
    expect(create).not.toHaveBeenCalled()
  })

  it('首个内容分片之后的流异常原样透传', async () => {
    const lost = new TypeError('network lost')
    const primary = streamModel('a', [start, delta('partial'), lost])
    const model = fallbackLanguageModel([
      { key: 'a', create: () => primary.model },
      { key: 'b', create: () => streamModel('b', [start, finish]).model },
    ])
    const result = await model.doStream(call)
    const reader = result.stream.getReader()
    expect(await reader.read()).toEqual({ done: false, value: start })
    expect(await reader.read()).toEqual({ done: false, value: delta('partial') })
    await expect(reader.read()).rejects.toBe(lost)
  })

  it('未配置的候选跳过，惰性构造', async () => {
    const events: TextFallbackEvent[] = []
    const third = vi.fn(() => streamModel('c', [start, finish]).model)
    const model = fallbackLanguageModel(
      [
        {
          key: 'a',
          create: () => {
            throw notConfigured()
          },
        },
        { key: 'b', create: () => new MockLanguageModelV4({ doGenerate: generated('b') }) },
        { key: 'c', create: third },
      ],
      { onFallback: (event) => events.push(event) },
    )
    const result = await model.doGenerate(call)
    expect(result.content).toEqual([{ type: 'text', text: 'b' }])
    expect(events).toEqual([{ from: 'a', to: 'b', kind: 'unavailable' }])
    expect(third).not.toHaveBeenCalled()
    expect(model.provider).toBe('fallback')
    expect(model.modelId).toBe('a')
  })

  it('不可切换的错误（400）直接抛出', async () => {
    const rejected = apiError(400)
    const create = vi.fn(() => new MockLanguageModelV4({ doGenerate: generated('b') }))
    const model = fallbackLanguageModel([
      { key: 'a', create: () => failingModel('a', rejected) },
      { key: 'b', create },
    ])
    await expect(model.doGenerate(call)).rejects.toBe(rejected)
    await expect(model.doStream(call)).rejects.toBe(rejected)
    expect(create).not.toHaveBeenCalled()
  })

  it('流内首分片前不可切换的 error 分片按原样交给调用方', async () => {
    const error: StreamPart = { type: 'error', error: apiError(400) }
    const primary = streamModel('a', [start, error])
    const model = fallbackLanguageModel([
      { key: 'a', create: () => primary.model },
      { key: 'b', create: () => streamModel('b', [start, finish]).model },
    ])
    const result = await model.doStream(call)
    expect(await convertReadableStreamToArray(result.stream)).toEqual([start, error])
    expect(model.selectedKey).toBe('a')
  })

  it('全部失败时抛出最后一个错误', async () => {
    const last = apiError(503)
    const events: TextFallbackEvent[] = []
    const model = fallbackLanguageModel(
      [
        { key: 'a', create: () => failingModel('a', apiError(429)) },
        { key: 'b', create: () => failingModel('b', apiError(401)) },
        { key: 'c', create: () => failingModel('c', last) },
      ],
      { onFallback: (event) => events.push(event) },
    )
    await expect(model.doGenerate(call)).rejects.toBe(last)
    expect(events).toEqual([
      { from: 'a', to: 'b', kind: 'rate_limited' },
      { from: 'b', to: 'c', kind: 'auth' },
    ])
    events.length = 0
    await expect(model.doStream(call)).rejects.toBe(last)
    expect(events).toHaveLength(2)
  })

  it('全部未配置时抛出未配置错误', async () => {
    const model = fallbackLanguageModel([
      {
        key: 'a',
        create: () => {
          throw notConfigured()
        },
      },
    ])
    await expect(model.doGenerate(call)).rejects.toMatchObject({ code: AI_PROVIDER_NOT_CONFIGURED })
  })

  it('最后一个候选的流内错误不再切换，原流交给调用方', async () => {
    const error: StreamPart = { type: 'error', error: apiError(503) }
    const primary = streamModel('a', [start, error])
    const backup = streamModel('b', [start, error])
    const model = fallbackLanguageModel([
      { key: 'a', create: () => primary.model },
      { key: 'b', create: () => backup.model },
    ])
    const result = await model.doStream(call)
    expect(await convertReadableStreamToArray(result.stream)).toEqual([start, error])
    expect(model.selectedKey).toBe('b')
  })

  it('调用方已中止时不切换', async () => {
    const controller = new AbortController()
    controller.abort()
    const aborted = apiError(503)
    const create = vi.fn(() => new MockLanguageModelV4({ doGenerate: generated('b') }))
    const model = fallbackLanguageModel([
      { key: 'a', create: () => failingModel('a', aborted) },
      { key: 'b', create },
    ])
    await expect(model.doGenerate({ ...call, abortSignal: controller.signal })).rejects.toBe(
      aborted,
    )
    await expect(model.doStream({ ...call, abortSignal: controller.signal })).rejects.toBe(aborted)
    expect(create).not.toHaveBeenCalled()
  })

  it('中止后的流内错误不切换', async () => {
    const controller = new AbortController()
    const lost = new DOMException('aborted', 'AbortError')
    const primary = streamModel('a', [start, lost])
    const create = vi.fn(() => streamModel('b', [start, finish]).model)
    primary.model.doStream = async () => {
      controller.abort()
      return { stream: streamOf([start, lost]).stream }
    }
    const model = fallbackLanguageModel([
      { key: 'a', create: () => primary.model },
      { key: 'b', create },
    ])
    const result = await model.doStream({ ...call, abortSignal: controller.signal })
    const reader = result.stream.getReader()
    expect(await reader.read()).toEqual({ done: false, value: start })
    await expect(reader.read()).rejects.toBe(lost)
    expect(create).not.toHaveBeenCalled()
  })

  it('取消选定流会传到上游', async () => {
    const primary = streamModel('a', [start, delta('x'), delta('y'), finish])
    const model = fallbackLanguageModel([{ key: 'a', create: () => primary.model }])
    const result = await model.doStream(call)
    const reader = result.stream.getReader()
    await reader.read()
    await reader.cancel('stop')
    expect(primary.cancel).toHaveBeenCalledWith('stop')
  })

  it('supportedUrls 取各候选共同支持的规则', async () => {
    const image = /^https:\/\/img\//
    const a = new MockLanguageModelV4({ supportedUrls: { 'image/*': [image, /^https:\/\/a\//] } })
    const b = new MockLanguageModelV4({ supportedUrls: { 'image/*': [/^https:\/\/img\//] } })
    const model = fallbackLanguageModel([
      { key: 'a', create: () => a },
      { key: 'b', create: () => b },
    ])
    expect(await model.supportedUrls).toEqual({ 'image/*': [image] })
  })
})
