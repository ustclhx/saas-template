import { AppError } from '@saas/shared'
import { z } from 'zod'
import { type FailureKind, failureKindFromStatus, ProviderFailure } from '../failover/failure.ts'
import type { MediaProvider, MediaResult, MediaStatus } from './provider.ts'

/*
 * kie.ai 统一任务接口（Market createTask / recordInfo）。核对日期 2026-11-27：
 * - 鉴权、HTTP 200 + body code 约定、限流：https://docs.kie.ai/getting-started
 * - 统一接口：https://docs.kie.ai/market/quickstart
 * - 查询与错误码：https://docs.kie.ai/market/common/get-task-detail
 * - 回调验签：https://docs.kie.ai/common-api/webhook-verification
 */
const API_ORIGIN = 'https://api.kie.ai'
const CREATE_TASK_URL = `${API_ORIGIN}/api/v1/jobs/createTask`
const RECORD_INFO_URL = `${API_ORIGIN}/api/v1/jobs/recordInfo`

/**
 * 产出主机：文档各模型 resultUrls 示例出现的精确主机名（2026-11-27 核对 248 个 Market 页面）。
 * 只允许精确主机名，staging 真实生成（任务 8.2）时再核对一次。
 */
export const KIE_OUTPUT_HOSTS = [
  'tempfile.aiquickdraw.com',
  'file.aiquickdraw.com',
  'static.aiquickdraw.com',
] as const

/**
 * 虽然已迁到 createTask，但结果结构不是 `{ resultUrls }` 或仍需专用接口的模型族（2026-11-27 核对）：
 * Veo 3.1（resultJson.data.result_urls）、4o Image（result_urls）、Flux Kontext（resultImageUrl）、Suno（专用接口）。
 * 首版不支持，登记与创建实例时拒绝。
 */
const UNSUPPORTED_MODEL_PREFIXES = [
  'veo',
  '4o-image',
  'gpt-4o-image',
  'flux1-kontext',
  'flux-kontext',
  'suno',
] as const
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i

/** kie 模型能否经统一任务接口提交并按 `{ resultUrls }` 解析结果；模型登记时据此拒绝。 */
export function isKieUnifiedModel(modelId: string): boolean {
  if (modelId.length > 128 || !MODEL_ID.test(modelId)) return false
  const lower = modelId.toLowerCase()
  return !UNSUPPORTED_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

const WEBHOOK_TOLERANCE_SECONDS = 300
const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const envelope = z.object({ code: z.number().int(), msg: z.string().nullish() })
const submitSchema = z.object({ data: z.object({ taskId }) })
const recordSchema = z.object({
  data: z.object({
    taskId,
    state: z.enum(['waiting', 'queuing', 'generating', 'success', 'fail']),
    resultJson: z.string().nullish(),
    failCode: z.string().nullish(),
    failMsg: z.string().nullish(),
  }),
})
const resultSchema = z.object({
  resultUrls: z.array(z.url({ protocol: /^https$/ })).min(1),
})
const webhookSchema = z.object({ data: z.object({ taskId }) })

export type KieSubmissionOutcome = 'ambiguous' | 'rejected'

/**
 * 字段名与 FalProviderError 一致（httpStatus / submissionOutcome），media-runner 按这两个字段判断能否重提。
 * httpStatus 为 HTTP 状态或 kie 的 body code；不附带上游正文，避免泄露参数与密钥。
 */
export class KieProviderError extends ProviderFailure {
  readonly httpStatus: number | undefined
  readonly submissionOutcome: KieSubmissionOutcome | undefined
  readonly causeName: string | undefined

  constructor(
    kind: FailureKind,
    code: string,
    message: string,
    options: {
      httpStatus?: number
      submissionOutcome?: KieSubmissionOutcome
      causeName?: string
    } = {},
  ) {
    super(kind, code, message)
    this.httpStatus = options.httpStatus
    this.submissionOutcome = options.submissionOutcome
    this.causeName = options.causeName
  }
}

// 失败说明里出现这些词时按内容审核处理；kie 文档的 failCode 400 同时涵盖参数、取图与审核失败。
const CONTENT_POLICY = /nsfw|sensitive|moderation|safety|violat|prohibited|policy/i

/**
 * kie body code / failCode → 失败分类（get-task-detail 错误码表，2026-11-27）：
 * 401 鉴权、402 余额不足 → auth；429 限流、433 子密钥额度 → rate_limited；
 * 455 维护、500 服务端、501 生成失败、408 超时 → provider_error；505 功能停用 → unavailable；
 * 400 / 404 / 422 参数 → rejected_input，说明含审核字样时为 content_policy。
 */
export function kieFailureKind(code: number | undefined, message?: string | null): FailureKind {
  if (code === 402) return 'auth'
  if (code === 433) return 'rate_limited'
  if (code === 455) return 'provider_error'
  if (code === 505) return 'unavailable'
  const kind = failureKindFromStatus(code)
  if ((kind === 'rejected_input' || code === 501) && message && CONTENT_POLICY.test(message))
    return 'content_policy'
  return kind
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

// 与 fal 相同：workerd 不支持 redirect: 'error'，用 manual 并由 !response.ok 拒绝 3xx。
const NO_REDIRECT = 'manual' as const

export interface KieMediaProviderOptions {
  apiKey: string
  /** 回调验签密钥（kie 设置页的 webhookHmacKey）。 */
  webhookSecret: string
  /** 每个任务按其 modelId 重建实例。 */
  modelId: string
  fetch: typeof fetch
  now?: () => number
}

function invalidResponse(submission?: KieSubmissionOutcome): never {
  throw new KieProviderError(
    submission === 'ambiguous' ? 'ambiguous' : 'provider_error',
    'KIE_INVALID_RESPONSE',
    'Invalid kie.ai response',
    submission === undefined ? {} : { submissionOutcome: submission },
  )
}

function parse<T>(schema: z.ZodType<T>, value: unknown, submission?: KieSubmissionOutcome): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) invalidResponse(submission)
  return parsed.data
}

const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
}

/** resultJson 是字符串；kie 不返回类型，只按明确的扩展名推导，同一任务的产出必须同为图片或视频。 */
function mediaResult(resultJson: string | null | undefined): MediaResult {
  let decoded: unknown
  try {
    decoded = JSON.parse(resultJson ?? '')
  } catch {
    invalidResponse()
  }
  const { resultUrls } = parse(resultSchema, decoded)
  const outputs = resultUrls.map((value) => {
    const url = new URL(value)
    if (!(KIE_OUTPUT_HOSTS as readonly string[]).includes(url.hostname)) invalidResponse()
    const mime = EXTENSION_MIME[url.pathname.split('.').pop()?.toLowerCase() ?? '']
    if (!mime) invalidResponse()
    return { url: value, mime }
  })
  const images = outputs.every((item) => item.mime.startsWith('image/'))
  if (!images && !outputs.every((item) => item.mime.startsWith('video/'))) invalidResponse()
  // 视频不报告时长：kie 不返回，运行时间不能当作视频时长。
  return { outputs, ...(images ? { usage: { images: outputs.length } } : {}) }
}

function invalidWebhook(): never {
  throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid kie.ai webhook', { status: 400 })
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}

export function createKieMediaProvider(options: KieMediaProviderOptions): MediaProvider {
  if (!isKieUnifiedModel(options.modelId))
    throw new AppError(
      'MODEL_UNAVAILABLE',
      'kie.ai model is not supported by the unified task API',
      {
        status: 404,
      },
    )
  const now = options.now ?? Date.now
  // 不能以 options 为 this 调用：Workers 的全局 fetch 会抛 Illegal invocation。
  const fetcher = options.fetch
  let hmacKey: Promise<CryptoKey> | undefined

  function notConfigured(): never {
    throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'kie.ai is not configured', { status: 503 })
  }

  /** kie 的业务错误以 HTTP 200 + body code 返回（getting-started §4），HTTP 层与 body 层都要检查。 */
  async function request(url: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    if (!options.apiKey) notConfigured()
    const submit = method === 'POST'
    let response: Response
    try {
      response = await fetcher(url, {
        method,
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new KieProviderError(
        submit ? 'ambiguous' : 'provider_error',
        'KIE_TRANSPORT_ERROR',
        'kie.ai request did not complete',
        { ...(submit ? { submissionOutcome: 'ambiguous' } : {}), causeName: errorName(error) },
      )
    }
    if (!response.ok) {
      const ambiguous = submit && (response.status >= 500 || response.status === 408)
      throw new KieProviderError(
        ambiguous ? 'ambiguous' : failureKindFromStatus(response.status),
        'KIE_HTTP_ERROR',
        `kie.ai HTTP request failed (${response.status})`,
        {
          httpStatus: response.status,
          ...(submit ? { submissionOutcome: ambiguous ? 'ambiguous' : 'rejected' } : {}),
        },
      )
    }
    const submission = submit ? 'ambiguous' : undefined
    let decoded: unknown
    try {
      decoded = await response.json()
    } catch {
      invalidResponse(submission)
    }
    const { code, msg } = parse(envelope, decoded, submission)
    if (code !== 200) {
      // body code 500 / 408 时无法确定任务是否已入队，按不确定处理，不重提也不切换；
      // 其余错误码（限流、鉴权、余额、参数、维护）文档说明请求未进入队列。
      const ambiguous = submit && (code === 500 || code === 408)
      throw new KieProviderError(
        ambiguous ? 'ambiguous' : kieFailureKind(code, msg),
        'KIE_API_ERROR',
        `kie.ai request failed (code ${code})`,
        {
          httpStatus: code,
          ...(submit ? { submissionOutcome: ambiguous ? 'ambiguous' : 'rejected' } : {}),
        },
      )
    }
    return decoded
  }

  function verificationKey(): Promise<CryptoKey> {
    hmacKey ??= crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(options.webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return hmacKey
  }

  return {
    id: 'kie',
    // 文档未提供幂等提交；沿用「不确定即不重提」路径。
    capabilities: { idempotentSubmit: false },
    async submit(input) {
      if (input.modelId !== options.modelId)
        throw new AppError(
          'KIE_INVALID_MODEL',
          'Model does not match this kie.ai provider instance',
        )
      const body = await request(CREATE_TASK_URL, 'POST', {
        model: options.modelId,
        input: input.params,
        ...(input.webhookUrl === undefined ? {} : { callBackUrl: input.webhookUrl }),
      })
      return { jobId: parse(submitSchema, body, 'ambiguous').data.taskId }
    },
    async getStatus(jobId): Promise<MediaStatus> {
      if (!taskId.safeParse(jobId).success)
        throw new AppError('KIE_INVALID_JOB', 'Invalid kie.ai task ID')
      const url = new URL(RECORD_INFO_URL)
      url.searchParams.set('taskId', jobId)
      const { data } = parse(recordSchema, await request(url.toString(), 'GET'))
      if (data.taskId !== jobId) invalidResponse()
      if (data.state === 'waiting' || data.state === 'queuing') return { status: 'queued' }
      if (data.state === 'generating') return { status: 'running' }
      if (data.state === 'fail') {
        const failCode = data.failCode && /^\d{3}$/.test(data.failCode) ? data.failCode : undefined
        // failMsg 可能复述上游原文或输入，只用于分类，不写入错误。
        return {
          status: 'failed',
          error: {
            code: 'KIE_GENERATION_FAILED',
            message: `kie.ai generation failed${failCode ? ` (failCode ${failCode})` : ''}`,
            kind: kieFailureKind(failCode ? Number(failCode) : 501, data.failMsg),
          },
        }
      }
      return { status: 'succeeded', result: mediaResult(data.resultJson) }
    },
    async parseWebhook(req, rawBody) {
      if (!options.webhookSecret) notConfigured()
      const timestamp = req.headers.get('x-webhook-timestamp')
      const signature = req.headers.get('x-webhook-signature')
      if (
        !timestamp ||
        !signature ||
        !/^\d{1,12}$/.test(timestamp) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(signature) ||
        // 文档未规定时间窗；签名不含正文，加 5 分钟窗口限制重放。
        Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS
      )
        invalidWebhook()
      let decoded: unknown
      try {
        decoded = JSON.parse(rawBody)
      } catch {
        invalidWebhook()
      }
      const parsed = webhookSchema.safeParse(decoded)
      if (!parsed.success) invalidWebhook()
      const jobId = parsed.data.data.taskId
      const bytes = base64Bytes(signature)
      // HMAC-SHA256(taskId + "." + timestamp)；subtle.verify 内部为常量时间比较。
      if (
        !bytes ||
        !(await crypto.subtle.verify(
          'HMAC',
          await verificationKey(),
          bytes,
          new TextEncoder().encode(`${jobId}.${timestamp}`),
        ))
      )
        invalidWebhook()
      // 签名不覆盖正文（文档明确要求以 recordInfo 为准），因此不采信回调里的状态与结果，交给调用方查询。
      return { jobId }
    },
  }
}
