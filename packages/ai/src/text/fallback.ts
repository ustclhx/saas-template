import { AppError } from '@saas/shared'
import { type LanguageModel, wrapLanguageModel } from 'ai'
import { canFailover, type FailureKind } from '../failover/failure.ts'
import { failureKindOfTextError } from '../failover/text-error.ts'
import { AI_PROVIDER_NOT_CONFIGURED } from './model.ts'

/**
 * 文本备用模型包装（add-media-provider-fallback 决策 D7）：按顺序尝试候选模型，
 * 只在服务商尚未返回任何输出时、且失败属于服务商侧原因时切换到下一候选。
 * 接口按已安装 AI SDK（ai 7.0.127 / @ai-sdk/provider 4.0.21）的 LanguageModelV4 规范实现；
 * 出处：https://ai-sdk.dev/providers/community-providers/custom-providers 与
 * https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v4/language-model-v4-stream-part.ts
 * （核对于 2026-11-27）。
 */

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>
type CallOptions = Parameters<LanguageModelV4['doStream']>[0]
type GenerateResult = Awaited<ReturnType<LanguageModelV4['doGenerate']>>
type StreamResult = Awaited<ReturnType<LanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer T> ? T : never

export interface TextModelCandidate {
  /** 候选模型的 ai_model.key，用于记录实际使用的模型。 */
  readonly key: string
  /** 首次使用时才构造；抛出 AI_PROVIDER_NOT_CONFIGURED 时跳过该候选。 */
  readonly create: () => LanguageModel
}

export interface TextFallbackEvent {
  /** 失败的候选 key */
  readonly from: string
  /** 接下来尝试的候选 key */
  readonly to: string
  /** 导致切换的失败分类 */
  readonly kind: FailureKind
}

export interface FallbackLanguageModelOptions {
  /** 每次切换到下一候选前调用。 */
  readonly onFallback?: (event: TextFallbackEvent) => void
  /** 每次调用确定实际使用的候选时调用（doGenerate 成功或 doStream 选定流）。 */
  readonly onSelected?: (key: string) => void
}

export type FallbackLanguageModel = LanguageModelV4 & {
  /** 最近一次调用实际使用的候选 key；尚未调用时为 undefined。并发调用请改用 onSelected。 */
  readonly selectedKey: string | undefined
}

/**
 * 尚未产生实际输出的分片：生命周期信息与各类「开始」标记。读到其他分片（含 finish 与未知类型）即视为已有输出，
 * 此后不再切换；未知类型按已输出处理，宁可不切换也不重复输出。
 */
const PRE_CONTENT_PARTS: ReadonlySet<string> = new Set([
  'stream-start',
  'response-metadata',
  'raw',
  'ping',
  'text-start',
  'reasoning-start',
  'tool-input-start',
])

type Slot = { readonly model: LanguageModelV4 } | { readonly unavailable: unknown }

function toV4(model: LanguageModel): LanguageModelV4 {
  if (typeof model === 'string')
    throw new AppError('AI_MODEL_INVALID', 'Fallback candidates must be model instances', {
      status: 500,
    })
  if (model.specificationVersion === 'v4') return model
  // 旧规范模型经 SDK 自带的适配器转为 V4，行为不变。
  return wrapLanguageModel({ model, middleware: [] })
}

function isNotConfigured(error: unknown): boolean {
  return error instanceof AppError && error.code === AI_PROVIDER_NOT_CONFIGURED
}

type ProbeResult =
  | { readonly status: 'content' | 'done'; readonly buffered: StreamPart[] }
  | {
      readonly status: 'error-part'
      readonly buffered: StreamPart[]
      readonly error: unknown
    }
  | { readonly status: 'thrown'; readonly buffered: StreamPart[]; readonly error: unknown }

/** 读到第一个内容分片、error 分片、流结束或流异常为止；读到的分片全部缓存，供选定后原样重放。 */
async function probe(reader: ReadableStreamDefaultReader<StreamPart>): Promise<ProbeResult> {
  const buffered: StreamPart[] = []
  for (;;) {
    let next: ReadableStreamReadResult<StreamPart>
    try {
      next = await reader.read()
    } catch (error) {
      return { status: 'thrown', buffered, error }
    }
    if (next.done) return { status: 'done', buffered }
    buffered.push(next.value)
    if (next.value.type === 'error')
      return { status: 'error-part', buffered, error: next.value.error }
    if (!PRE_CONTENT_PARTS.has(next.value.type)) return { status: 'content', buffered }
  }
}

/** 先重放探测时读到的分片，再透传剩余部分；取消向上游传递。 */
function replay(
  reader: ReadableStreamDefaultReader<StreamPart>,
  probed: ProbeResult,
): ReadableStream<StreamPart> {
  const buffered = [...probed.buffered]
  return new ReadableStream<StreamPart>(
    {
      // 逐个在 pull 中交出缓存：在 start 里 error() 会清空已入队的分片。
      async pull(controller) {
        const part = buffered.shift()
        if (part) {
          controller.enqueue(part)
          return
        }
        if (probed.status === 'thrown') {
          controller.error(probed.error)
          return
        }
        if (probed.status === 'done') {
          controller.close()
          return
        }
        try {
          const next = await reader.read()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

/** 主候选的 supportedUrls 只对主模型成立；多个候选时取各候选都声明的相同规则，避免把备用模型不支持的 URL 直接传给它。 */
async function commonSupportedUrls(
  models: readonly LanguageModelV4[],
): Promise<Record<string, RegExp[]>> {
  const all = await Promise.all(models.map((model) => model.supportedUrls))
  const [first, ...rest] = all
  if (!first) return {}
  const result: Record<string, RegExp[]> = {}
  for (const [mediaType, patterns] of Object.entries(first)) {
    const common = patterns.filter((pattern) =>
      rest.every((other) =>
        (other[mediaType] ?? []).some(
          (candidate) => candidate.source === pattern.source && candidate.flags === pattern.flags,
        ),
      ),
    )
    if (common.length > 0) result[mediaType] = common
  }
  return result
}

/**
 * 返回按顺序尝试候选的 LanguageModelV4。
 * - doGenerate：失败可切换则试下一候选，否则抛出；全部失败抛出最后一个错误。
 * - doStream：连接期失败同上；连接后在第一个内容分片之前遇到 error 分片或流异常且可切换时，取消该流并试下一候选；
 *   第一个内容分片之后的错误原样透传。没有可切换的下一候选时，当前流按原样（含已读分片与错误）交给调用方。
 * - 调用方 abortSignal 已中止时不切换。
 * - provider / modelId 取主候选；主候选未配置时 provider 为 `fallback`、modelId 为主候选 key。
 */
export function fallbackLanguageModel(
  candidates: readonly TextModelCandidate[],
  options: FallbackLanguageModelOptions = {},
): FallbackLanguageModel {
  const [primary] = candidates
  if (!primary)
    throw new AppError('AI_MODEL_INVALID', 'Fallback model requires at least one candidate', {
      status: 500,
    })
  const slots = new Map<number, Slot>()
  let selectedKey: string | undefined

  /** 惰性构造并缓存；未配置返回 undefined，其他构造错误直接抛出。 */
  const resolve = (index: number): LanguageModelV4 | undefined => {
    let slot = slots.get(index)
    if (!slot) {
      const candidate = candidates[index]
      if (!candidate) return undefined
      try {
        slot = { model: toV4(candidate.create()) }
      } catch (error) {
        if (!isNotConfigured(error)) throw error
        slot = { unavailable: error }
      }
      slots.set(index, slot)
    }
    return 'model' in slot ? slot.model : undefined
  }
  const unavailableError = (index: number): unknown => {
    const slot = slots.get(index)
    return slot && 'unavailable' in slot ? slot.unavailable : undefined
  }
  const hasNext = (index: number): boolean => {
    for (let next = index + 1; next < candidates.length; next++) if (resolve(next)) return true
    return false
  }
  const select = (key: string) => {
    selectedKey = key
    options.onSelected?.(key)
  }
  const switchable = (error: unknown, call: CallOptions): FailureKind | undefined => {
    if (call.abortSignal?.aborted) return undefined
    const kind = failureKindOfTextError(error)
    return canFailover(kind) ? kind : undefined
  }

  /** 依次尝试候选；attempt 返回 undefined 表示已记录失败、应切换。 */
  async function run<T>(
    attempt: (
      model: LanguageModelV4,
      index: number,
      fail: (error: unknown, kind: FailureKind) => undefined,
    ) => Promise<T | undefined>,
  ): Promise<T> {
    let last: { key: string; kind: FailureKind; error: unknown } | undefined
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index] as TextModelCandidate
      const model = resolve(index)
      if (!model) {
        // 未配置的候选直接跳过；已有实际尝试的失败时保留它（更能说明原因），全部未配置时抛出未配置错误。
        last ??= { key: candidate.key, kind: 'unavailable', error: unavailableError(index) }
        continue
      }
      if (last) options.onFallback?.({ from: last.key, to: candidate.key, kind: last.kind })
      const fail = (error: unknown, kind: FailureKind): undefined => {
        last = { key: candidate.key, kind, error }
        return undefined
      }
      const result = await attempt(model, index, fail)
      if (result !== undefined) {
        select(candidate.key)
        return result
      }
    }
    throw last?.error
  }

  const wrapper: FallbackLanguageModel = {
    specificationVersion: 'v4',
    get provider() {
      return resolve(0)?.provider ?? 'fallback'
    },
    get modelId() {
      return resolve(0)?.modelId ?? primary.key
    },
    get supportedUrls() {
      return commonSupportedUrls(
        candidates.map((_, index) => resolve(index)).filter((model) => model !== undefined),
      )
    },
    get selectedKey() {
      return selectedKey
    },
    doGenerate(call: CallOptions): Promise<GenerateResult> {
      return run(async (model, _index, fail) => {
        try {
          return await model.doGenerate(call)
        } catch (error) {
          const kind = switchable(error, call)
          if (!kind) throw error
          return fail(error, kind)
        }
      })
    },
    doStream(call: CallOptions): Promise<StreamResult> {
      return run(async (model, index, fail) => {
        let result: StreamResult
        try {
          result = await model.doStream(call)
        } catch (error) {
          const kind = switchable(error, call)
          if (!kind) throw error
          return fail(error, kind)
        }
        const reader = result.stream.getReader()
        const probed = await probe(reader)
        if (probed.status === 'error-part' || probed.status === 'thrown') {
          const kind = switchable(probed.error, call)
          if (kind && hasNext(index)) {
            await reader.cancel().catch(() => undefined)
            return fail(probed.error, kind)
          }
        }
        return { ...result, stream: replay(reader, probed) }
      })
    },
  }
  return wrapper
}
