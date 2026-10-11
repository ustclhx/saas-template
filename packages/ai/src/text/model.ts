import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { AppError } from '@saas/shared'
import type { LanguageModel } from 'ai'
import type { AvailableModel } from '../models.ts'

/**
 * 文本模型的构造（docs/06-ai.md §3「实现」）：按 `ai_model.provider` 返回经 AI Gateway 的
 * AI SDK 模型实例。接口调用方通过可注入的工厂取模型，测试注入模拟模型。
 */

/** 构造模型所需的环境变量（AI Gateway 端点与鉴权，design 决策 8） */
export interface TextModelEnv {
  /** Cloudflare 账号 id 与 Gateway 名称，组成 Gateway 的服务商兼容端点 */
  readonly AI_GATEWAY_ACCOUNT_ID?: string | undefined
  readonly AI_GATEWAY_ID?: string | undefined
  /** Gateway 开启鉴权时携带 */
  readonly AI_GATEWAY_TOKEN?: string | undefined
  /** 默认使用 Gateway BYOK；显式提供时仍经 Gateway 转发服务商密钥 */
  readonly OPENAI_API_KEY?: string | undefined
  readonly ANTHROPIC_API_KEY?: string | undefined
  readonly GOOGLE_API_KEY?: string | undefined
  readonly DEEPSEEK_API_KEY?: string | undefined
}

export type LanguageModelFactory = (model: AvailableModel, env: TextModelEnv) => LanguageModel

export const AI_PROVIDER_NOT_CONFIGURED = 'AI_PROVIDER_NOT_CONFIGURED'

function gatewayOptions(
  baseURL: string,
  env: TextModelEnv,
  key: string | undefined,
  authHeader: string,
) {
  const apiKey = key?.trim() || undefined
  const token = env.AI_GATEWAY_TOKEN?.trim()
  return {
    baseURL,
    // SDK 要求 API key；占位值阻止其回退读取 process.env，发送前移除对应鉴权头。
    apiKey: apiKey ?? 'cloudflare-gateway-byok',
    headers: token ? { 'cf-aig-authorization': `Bearer ${token}` } : {},
    fetch: ((input, init) => {
      if (apiKey) return globalThis.fetch(input, init)
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      headers.delete(authHeader)
      return globalThis.fetch(input, { ...init, headers })
    }) satisfies typeof fetch,
  }
}

/** 使用各家官方 SDK 的协议与 Gateway 兼容端点；所有模型请求都经过 Gateway。 */
export const defaultLanguageModelFactory: LanguageModelFactory = (model, env) => {
  const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim()
  const gatewayId = env.AI_GATEWAY_ID?.trim()
  if (!accountId || !gatewayId) {
    throw new AppError(AI_PROVIDER_NOT_CONFIGURED, 'AI Gateway is not configured', { status: 503 })
  }
  const baseURL = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}`
  switch (model.provider) {
    case 'openai':
      return createOpenAI(
        gatewayOptions(`${baseURL}/openai`, env, env.OPENAI_API_KEY, 'authorization'),
      ).chat(model.providerModelId)
    case 'anthropic':
      return createAnthropic(
        gatewayOptions(`${baseURL}/anthropic/v1`, env, env.ANTHROPIC_API_KEY, 'x-api-key'),
      )(model.providerModelId)
    case 'google':
      return createGoogleGenerativeAI(
        gatewayOptions(
          `${baseURL}/google-ai-studio/v1beta`,
          env,
          env.GOOGLE_API_KEY,
          'x-goog-api-key',
        ),
      )(model.providerModelId)
    case 'deepseek':
      return createDeepSeek(
        gatewayOptions(`${baseURL}/deepseek`, env, env.DEEPSEEK_API_KEY, 'authorization'),
      )(model.providerModelId)
    default:
      throw new AppError(
        AI_PROVIDER_NOT_CONFIGURED,
        `No language model provider is configured for ${model.provider}`,
        { status: 503 },
      )
  }
}
