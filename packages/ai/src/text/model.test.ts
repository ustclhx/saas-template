import { generateText } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvailableModel } from '../models.ts'
import {
  AI_PROVIDER_NOT_CONFIGURED,
  defaultLanguageModelFactory,
  type TextModelEnv,
} from './model.ts'

const env: TextModelEnv = {
  AI_GATEWAY_ACCOUNT_ID: 'account',
  AI_GATEWAY_ID: 'gateway',
  AI_GATEWAY_TOKEN: 'gateway-token',
}

const providers = [
  {
    provider: 'openai',
    path: 'openai/chat/completions',
    key: 'OPENAI_API_KEY',
    header: 'authorization',
  },
  {
    provider: 'anthropic',
    path: 'anthropic/v1/messages',
    key: 'ANTHROPIC_API_KEY',
    header: 'x-api-key',
  },
  {
    provider: 'google',
    path: 'google-ai-studio/v1beta/models/model-id:generateContent',
    key: 'GOOGLE_API_KEY',
    header: 'x-goog-api-key',
  },
  {
    provider: 'deepseek',
    path: 'deepseek/chat/completions',
    key: 'DEEPSEEK_API_KEY',
    header: 'authorization',
  },
] as const

function model(provider: string): AvailableModel {
  return {
    id: 'm',
    key: 'display-key',
    kind: 'text',
    provider,
    providerModelId: 'model-id',
    pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1 },
    tags: [],
    paramsSchema: null,
    sort: 0,
  }
}

function response(provider: string) {
  if (provider === 'anthropic')
    return {
      id: 'response',
      type: 'message',
      role: 'assistant',
      model: 'model-id',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }
  if (provider === 'google')
    return {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
    }
  return {
    id: 'response',
    created: 1,
    model: 'model-id',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Gateway 默认模型工厂', () => {
  it.each(providers)(
    '$provider 默认 BYOK，经兼容端点发送 Gateway 鉴权，不读取 SDK 环境密钥',
    async ({ provider, path, key }) => {
      vi.stubEnv(key, 'unintended-process-key')
      // Google SDK 默认读取的环境变量与本项目显式绑定名不同。
      vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'unintended-google-key')
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'unintended-anthropic-token')
      let request: Request | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          request = new Request(input, init)
          return Response.json(response(provider))
        }),
      )
      const result = await generateText({
        model: defaultLanguageModelFactory(model(provider), env),
        prompt: 'hello',
        maxOutputTokens: 32,
        maxRetries: 0,
      })
      expect(result.text).toBe('hello')
      expect(request?.url).toBe(`https://gateway.ai.cloudflare.com/v1/account/gateway/${path}`)
      expect(request?.headers.get('cf-aig-authorization')).toBe('Bearer gateway-token')
      for (const header of ['authorization', 'x-api-key', 'x-goog-api-key']) {
        expect(request?.headers.has(header)).toBe(false)
      }
      const body = await request?.json()
      if (provider !== 'google') expect(body.model).toBe('model-id')
      if (provider === 'anthropic')
        expect(request?.headers.get('anthropic-version')).toBe('2023-06-01')
    },
  )

  it.each(providers)(
    '$provider 可显式提供服务商密钥，仍经 Gateway',
    async ({ provider, path, key, header }) => {
      let request: Request | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          request = new Request(input, init)
          return Response.json(response(provider))
        }),
      )
      await generateText({
        model: defaultLanguageModelFactory(model(provider), { ...env, [key]: 'provider-key' }),
        prompt: 'hello',
        maxOutputTokens: 32,
        maxRetries: 0,
      })
      expect(request?.url).toBe(`https://gateway.ai.cloudflare.com/v1/account/gateway/${path}`)
      expect(request?.headers.get('cf-aig-authorization')).toBe('Bearer gateway-token')
      expect(request?.headers.get(header)).toBe(
        header === 'authorization' ? 'Bearer provider-key' : 'provider-key',
      )
    },
  )

  it.each([
    { provider: 'openai', config: {} },
    { provider: 'openai', config: { ...env, AI_GATEWAY_ACCOUNT_ID: ' ' } },
    { provider: 'openai', config: { ...env, AI_GATEWAY_ID: '' } },
    { provider: 'unsupported', config: env },
  ])('配置缺失或 provider=$provider 不支持时，调用前返回 503', ({ provider, config }) => {
    expect(() => defaultLanguageModelFactory(model(provider), config)).toThrowError(
      expect.objectContaining({ code: AI_PROVIDER_NOT_CONFIGURED, status: 503 }),
    )
  })
})
