import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { type LanguageModel, wrapLanguageModel } from 'ai'
import type { ModelCandidate } from '../models.ts'
import { textModelConfig } from './budget.ts'
import { getTextProviderCapabilities, resolveTextThinking } from './capabilities.ts'
import {
  type FallbackLanguageModel,
  fallbackLanguageModel,
  type TextFallbackEvent,
} from './fallback.ts'
import { AI_PROVIDER_NOT_CONFIGURED } from './model.ts'

/**
 * 文本备用链的装配（add-media-provider-fallback 决策 D7，specs/ai-text-runtime「文本备用模型切换」）：
 * 对话、后续问题与 agent 共用。每个候选经调用方的工厂惰性构造，思考参数按**该候选自己**的 provider 与
 * `x-text.thinking` 下发（主模型的 providerOptions 对备用服务商无意义，通用 `reasoning` 参数也不能沿用）。
 * 定价、预扣与 token 上限由调用方按主模型（第一个候选）计算，这里不涉及。
 */

/** 实际生成本次输出的候选：续写须固定在它上面，能力按它的 provider 取。 */
export interface SelectedTextCandidate {
  readonly key: string
  readonly provider: string
  /** 该候选已构造的模型（含思考参数与调用方的包装），续写时直接调用、不再走备用链 */
  readonly model: LanguageModel
  /** 该候选是否配置了原生续写（`x-text.continuation = native`） */
  readonly continuation: boolean
}

export interface TextCandidateChain {
  /** 交给 streamText / generateText 的模型 */
  readonly model: FallbackLanguageModel
  /** 最近一次调用实际使用的候选；尚未调用或全部失败时为 undefined */
  selected(): SelectedTextCandidate | undefined
  /**
   * 调用前确认至少有一个候选的服务商已配置（按顺序构造到第一个成功为止）；全部未配置时抛出主候选的
   * AI_PROVIDER_NOT_CONFIGURED，让调用方在预扣前拒绝，与接入备用前的行为一致。
   */
  ensureAvailable(): void
}

export interface TextCandidateChainOptions {
  /** `resolveModelCandidates` 的结果，第一个为主模型 */
  readonly candidates: readonly ModelCandidate[]
  /** 构造单个候选；未配置的服务商抛出 AI_PROVIDER_NOT_CONFIGURED 即被跳过 */
  readonly create: (candidate: ModelCandidate, index: number) => LanguageModel
  /**
   * 本次请求希望的 thinking；省略表示不下发任何思考参数（如 agent）。
   * 每个候选再按自己的 provider 与 `x-text.thinking` 经 `resolveTextThinking` 决定实际下发值。
   */
  readonly thinking?: boolean | undefined
  /** `ai.text.failover` 日志携带的定位字段（会话 / 消息 / 轮次 id），不含提示词 */
  readonly logContext?: Readonly<Record<string, string>>
  readonly onFallback?: (event: TextFallbackEvent) => void
  readonly onSelected?: (key: string) => void
}

/** 按候选自身 provider 下发思考参数；Provider 不可控时原样调用。 */
function withThinking(
  model: LanguageModel,
  candidate: ModelCandidate,
  requested: boolean | undefined,
): LanguageModel {
  if (requested === undefined || typeof model === 'string') return model
  const thinking = resolveTextThinking(
    candidate.provider,
    textModelConfig(candidate).thinking,
    requested,
  )
  if (thinking === undefined) return model
  const capabilities = getTextProviderCapabilities(candidate.provider)
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => capabilities.applyThinking(params, thinking),
    },
  })
}

type Built = { readonly model: LanguageModel } | { readonly error: unknown }

export function createTextCandidateChain(options: TextCandidateChainOptions): TextCandidateChain {
  // 每个候选只构造一次：ensureAvailable 与备用链共用同一实例（或同一构造错误）。
  const built = new Map<number, Built>()
  const build = (index: number): LanguageModel => {
    let entry = built.get(index)
    if (!entry) {
      const candidate = options.candidates[index] as ModelCandidate
      try {
        entry = {
          model: withThinking(options.create(candidate, index), candidate, options.thinking),
        }
      } catch (error) {
        entry = { error }
      }
      built.set(index, entry)
    }
    if ('error' in entry) throw entry.error
    return entry.model
  }
  const model = fallbackLanguageModel(
    options.candidates.map((candidate, index) => ({
      key: candidate.key,
      create: () => build(index),
    })),
    {
      onFallback: (event) => {
        log.warn('ai.text.failover', { ...options.logContext, ...event })
        options.onFallback?.(event)
      },
      ...(options.onSelected ? { onSelected: options.onSelected } : {}),
    },
  )
  return {
    model,
    selected() {
      const index = options.candidates.findIndex((item) => item.key === model.selectedKey)
      const candidate = options.candidates[index]
      const entry = built.get(index)
      if (!candidate || !entry || !('model' in entry)) return undefined
      return {
        key: candidate.key,
        provider: candidate.provider,
        model: entry.model,
        continuation: textModelConfig(candidate).continuation === 'native',
      }
    },
    ensureAvailable() {
      let first: unknown
      for (let index = 0; index < options.candidates.length; index++) {
        try {
          build(index)
          return
        } catch (error) {
          if (!(error instanceof AppError && error.code === AI_PROVIDER_NOT_CONFIGURED)) throw error
          first ??= error
        }
      }
      throw first
    },
  }
}
