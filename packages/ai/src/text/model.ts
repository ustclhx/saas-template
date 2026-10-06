import { AppError } from '@saas/shared'
import type { LanguageModel } from 'ai'
import type { AvailableModel } from '../models.ts'

/**
 * 文本模型的构造（docs/06-ai.md §3「实现」）：按 `ai_model.provider` 返回经 AI Gateway 的
 * AI SDK 模型实例。接口调用方通过可注入的工厂取模型，测试注入模拟模型。
 */

/** 构造模型所需的环境变量（AI Gateway 端点与鉴权，design 决策 8）；取值由工厂实现读取 */
export interface TextModelEnv {
  /** Cloudflare 账号 id 与 Gateway 名称，组成 Gateway 的服务商兼容端点 */
  readonly AI_GATEWAY_ACCOUNT_ID?: string | undefined
  readonly AI_GATEWAY_ID?: string | undefined
  /** Gateway 开启鉴权时携带 */
  readonly AI_GATEWAY_TOKEN?: string | undefined
}

export type LanguageModelFactory = (model: AvailableModel, env: TextModelEnv) => LanguageModel

export const AI_PROVIDER_NOT_CONFIGURED = 'AI_PROVIDER_NOT_CONFIGURED'

/** 默认工厂：经 AI Gateway 的服务商实现完成前，一律返回 503 */
export const defaultLanguageModelFactory: LanguageModelFactory = (model) => {
  throw new AppError(
    AI_PROVIDER_NOT_CONFIGURED,
    `No language model provider is configured for ${model.provider}`,
    { status: 503 },
  )
}
