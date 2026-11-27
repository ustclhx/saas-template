import { AppError } from '@saas/shared'
import { APICallError, generateText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelCandidate } from '../models.ts'
import { createTextCandidateChain } from './candidates.ts'
import { AI_PROVIDER_NOT_CONFIGURED } from './model.ts'

const candidate = (
  key: string,
  provider: string,
  text: Record<string, unknown> = {},
): ModelCandidate => ({
  id: key,
  key,
  kind: 'text',
  provider,
  providerModelId: key,
  pricing: { mode: 'per_call', credits: 1 },
  tags: [],
  paramsSchema: { 'x-text': text },
  sort: 0,
  fallbacks: [],
})

const ok = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  })
const rateLimited = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message: 'rate limited',
        url: 'https://provider.example/v1',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: false,
      })
    },
  })
const notConfigured = () => {
  throw new AppError(AI_PROVIDER_NOT_CONFIGURED, 'not configured', { status: 503 })
}

afterEach(() => vi.restoreAllMocks())

describe('createTextCandidateChain', () => {
  it('思考参数按各候选自己的 provider 下发；selected 返回实际候选并记录 ai.text.failover', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const primary = rateLimited()
    const backup = ok('from backup')
    const models: Record<string, MockLanguageModelV4> = { a: primary, b: backup }
    const chain = createTextCandidateChain({
      candidates: [
        candidate('a', 'openai'),
        candidate('b', 'deepseek', { continuation: 'native', thinking: false }),
      ],
      create: (item) => models[item.key] as MockLanguageModelV4,
      thinking: true,
      logContext: { messageId: 'm1' },
    })
    const result = await generateText({ model: chain.model, prompt: 'hi', maxRetries: 0 })
    expect(result.text).toBe('from backup')
    // openai 无思考适配器：不改动请求；deepseek 配置 thinking=false：下发关闭
    expect(primary.doGenerateCalls[0]?.providerOptions).toBeUndefined()
    expect(backup.doGenerateCalls[0]?.providerOptions).toMatchObject({
      deepseek: { thinking: { type: 'disabled' } },
    })
    expect(chain.selected()).toMatchObject({ key: 'b', provider: 'deepseek', continuation: true })
    const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'ai.text.failover',
        messageId: 'm1',
        from: 'a',
        to: 'b',
        kind: 'rate_limited',
      }),
    )
  })

  it('ensureAvailable：跳过未配置的主候选；全部未配置时抛出主候选的未配置错误；其他构造错误直接抛出', () => {
    const create = vi.fn((item: ModelCandidate) => (item.key === 'a' ? notConfigured() : ok('x')))
    const chain = createTextCandidateChain({
      candidates: [candidate('a', 'openai'), candidate('b', 'anthropic')],
      create,
    })
    expect(() => chain.ensureAvailable()).not.toThrow()
    chain.ensureAvailable()
    // 每个候选只构造一次
    expect(create).toHaveBeenCalledTimes(2)

    const none = createTextCandidateChain({
      candidates: [candidate('a', 'openai'), candidate('b', 'anthropic')],
      create: notConfigured,
    })
    expect(() => none.ensureAvailable()).toThrow(
      expect.objectContaining({ code: AI_PROVIDER_NOT_CONFIGURED }),
    )

    const broken = createTextCandidateChain({
      candidates: [candidate('a', 'openai')],
      create: () => {
        throw new Error('bad config')
      },
    })
    expect(() => broken.ensureAvailable()).toThrow('bad config')
  })

  it('未下发 thinking 时不包装模型（agent）', async () => {
    const model = ok('plain')
    const chain = createTextCandidateChain({
      candidates: [candidate('a', 'deepseek')],
      create: () => model,
    })
    await generateText({ model: chain.model, prompt: 'hi', maxRetries: 0 })
    expect(model.doGenerateCalls[0]?.providerOptions).toBeUndefined()
    expect(chain.selected()?.model).toBe(model)
  })
})
