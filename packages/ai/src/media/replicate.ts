import { AppError } from '@saas/shared'
import { z } from 'zod'
import { type FailureKind, failureKindFromStatus, ProviderFailure } from '../failover/failure.ts'
import type { MediaError, MediaProvider, MediaResult, MediaStatus } from './provider.ts'

/*
 * Replicate HTTP API 适配器（add-media-provider-fallback 决策 D1）。出处，核对于 2026-11-27：
 * - 预测接口：https://replicate.com/docs/reference/http
 *   （models.predictions.create / predictions.create / predictions.get / predictions.cancel）
 * - 状态：https://replicate.com/docs/topics/predictions/lifecycle
 * - 回调验签：https://replicate.com/docs/topics/webhooks/verify-webhook
 *   与 Standard Webhooks 规范 https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 * - 错误码：https://replicate.com/docs/reference/error-codes
 * - 产出保留：https://replicate.com/docs/topics/predictions/data-retention（API 预测的产出 1 小时后删除）
 */
const API_ORIGIN = 'https://api.replicate.com'

/**
 * 官方文档写明产出由 `replicate.delivery` 及其子域名提供；只放行文档确认的精确主机名，
 * 子域名须在真实回包中出现后逐个加入（staging 验收 8.2）。
 */
export const REPLICATE_OUTPUT_HOSTS = ['replicate.delivery'] as const

const TIMESTAMP_TOLERANCE_SEC = 5 * 60
const MAX_ERROR_MESSAGE = 300
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const VERSION = /^[a-f0-9]{64}$/
// 文档示例 ID 为 26 位小写字母与数字（如 gm3qorzdhgbfurvjtvhg6dckhu）；限制字符集以防路径注入。
const predictionId = z.string().regex(/^[a-zA-Z0-9]{1,64}$/)

const predictionSchema = z.object({
  id: predictionId,
  // lifecycle 页另列 aborted（启动前超过截止时间）；HTTP 参考尚未列出，一并接受。
  status: z.enum(['starting', 'processing', 'succeeded', 'failed', 'canceled', 'aborted']),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
})
const outputSchema = z.union([
  z.url({ protocol: /^https$/ }),
  z.array(z.url({ protocol: /^https$/ })).min(1),
])

type Prediction = z.infer<typeof predictionSchema>
export type ReplicateSubmissionOutcome = 'ambiguous' | 'rejected'

/**
 * 不附带上游响应正文或网络错误，避免泄露参数与密钥。
 * submissionOutcome / httpStatus 与 fal 适配器同名，供现有 Runner 判断提交是否确定被拒。
 */
export class ReplicateProviderError extends ProviderFailure {
  readonly httpStatus: number | undefined
  readonly submissionOutcome: ReplicateSubmissionOutcome | undefined
  readonly causeName: string | undefined

  constructor(
    kind: FailureKind,
    code: string,
    message: string,
    options: {
      httpStatus?: number | undefined
      submissionOutcome?: ReplicateSubmissionOutcome | undefined
      causeName?: string | undefined
    } = {},
  ) {
    super(kind, code, message)
    this.httpStatus = options.httpStatus
    this.submissionOutcome = options.submissionOutcome
    this.causeName = options.causeName
  }
}

// workerd 不支持 redirect: 'error'；manual 后由 !response.ok 拒绝 3xx，同样不跟随重定向。
const NO_REDIRECT = 'manual' as const

export interface ReplicateMediaProviderOptions {
  apiToken: string
  /** Standard Webhooks 密钥（`whsec_` + base64），由 GET /v1/webhooks/default/secret 取得。 */
  webhookSecret: string
  /** `owner/name`（官方模型）或 `owner/name:<64 位版本号>`。 */
  modelId: string
  fetch: typeof fetch
  now?: () => number
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function invalidResponse(submission?: ReplicateSubmissionOutcome): never {
  throw new ReplicateProviderError(
    submission === 'ambiguous' ? 'ambiguous' : 'provider_error',
    'REPLICATE_INVALID_RESPONSE',
    'Invalid Replicate response',
    { submissionOutcome: submission },
  )
}

function invalidWebhook(): never {
  throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid Replicate webhook', { status: 400 })
}

function notConfigured(what: string): never {
  throw new AppError('AI_PROVIDER_NOT_CONFIGURED', `Replicate ${what} is not configured`, {
    status: 503,
  })
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
}

/** output 为单个 URL 或 URL 数组；只接受白名单主机，mime 只按明确扩展名推导（与 fal 一致）。 */
function mediaResult(value: unknown): MediaResult {
  const parsed = outputSchema.safeParse(value)
  if (!parsed.success) invalidResponse()
  const urls = typeof parsed.data === 'string' ? [parsed.data] : parsed.data
  const outputs = urls.map((raw) => {
    const url = new URL(raw)
    if (!(REPLICATE_OUTPUT_HOSTS as readonly string[]).includes(url.hostname)) invalidResponse()
    const mime = MIME_BY_EXTENSION[url.pathname.split('.').pop()?.toLowerCase() ?? '']
    if (!mime) invalidResponse()
    return { url: raw, mime }
  })
  const images = outputs.every((output) => output.mime.startsWith('image/'))
  const videos = outputs.every((output) => output.mime.startsWith('video/'))
  if (!images && !videos) invalidResponse()
  // 只报告服务商给出的用量；metrics.predict_time 是运行时间，不能当作视频时长。
  return { outputs, ...(images ? { usage: { images: outputs.length } } : {}) }
}

/*
 * Replicate 未在文档中给出内容审核的错误码；以下文本来自其模型实际返回的失败信息
 * （FLUX / SDXL 安全检查器「NSFW content detected」，Google 系模型「flagged as sensitive (E005)」），
 * staging 验收 8.2 时按真实回包补充。未识别的失败一律按 provider_error。
 */
const CONTENT_POLICY =
  /nsfw|flagged as sensitive|\(E005\)|safety (checker|filter|system)|content (policy|moderation)/i

function predictionError(prediction: Prediction): MediaError {
  if (prediction.status === 'canceled')
    return {
      code: 'REPLICATE_CANCELED',
      message: 'Replicate prediction was canceled',
      kind: 'provider_error',
    }
  if (prediction.status === 'aborted')
    return {
      code: 'REPLICATE_ABORTED',
      message: 'Replicate prediction exceeded its deadline before starting',
      kind: 'provider_error',
    }
  const text = typeof prediction.error === 'string' ? prediction.error : ''
  const message = (text || 'Replicate prediction failed').slice(0, MAX_ERROR_MESSAGE)
  if (CONTENT_POLICY.test(text))
    return { code: 'REPLICATE_CONTENT_POLICY', message, kind: 'content_policy' }
  const code = text.match(/\bE(\d{4})\b/)?.[1]
  // 文档列出的 E#### 均为平台侧故障（OOM、启动失败、上传失败等），按 provider_error 可切换。
  return {
    code: code ? `REPLICATE_E${code}` : 'REPLICATE_GENERATION_FAILED',
    message,
    kind: 'provider_error',
  }
}

/** succeeded / failed / canceled / aborted 为终态；终态成功但产出已被删除时按服务商失败处理。 */
function toStatus(prediction: Prediction): MediaStatus {
  if (prediction.status === 'starting' || prediction.status === 'processing')
    return { status: 'running' }
  if (prediction.status !== 'succeeded')
    return { status: 'failed', error: predictionError(prediction) }
  if (prediction.output == null)
    return {
      status: 'failed',
      error: {
        code: 'REPLICATE_OUTPUT_REMOVED',
        message: 'Replicate prediction output is no longer available',
        kind: 'provider_error',
      },
    }
  return { status: 'succeeded', result: mediaResult(prediction.output) }
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** 读取 `whsec_` + base64 形式的密钥；格式不对时视为未配置（503），不是回调伪造。 */
export async function importReplicateWebhookSecret(secret: string): Promise<CryptoKey> {
  const bytes = secret.startsWith('whsec_') ? base64Bytes(secret.slice(6)) : undefined
  if (!bytes || bytes.length === 0) notConfigured('webhook secret')
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
}

/**
 * Standard Webhooks 验签：签名内容为 `${webhook-id}.${webhook-timestamp}.${原始正文}`，
 * 头部为空格分隔的「版本,base64 签名」列表，只认 v1（HMAC-SHA256）；subtle.verify 为常量时间比较。
 * 时间戳与当前时间相差超过 5 分钟即拒绝，防止重放。
 */
export async function verifyReplicateWebhook(
  key: CryptoKey,
  headers: Headers,
  rawBody: string,
  nowMs: number,
): Promise<boolean> {
  const id = headers.get('webhook-id')
  const timestamp = headers.get('webhook-timestamp')
  const signatures = headers.get('webhook-signature')
  if (
    !id ||
    !timestamp ||
    !signatures ||
    id.includes('.') ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > TIMESTAMP_TOLERANCE_SEC
  )
    return false
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)
  for (const entry of signatures.split(' ')) {
    const [scheme, value] = entry.split(',', 2)
    if (scheme !== 'v1' || !value) continue
    const bytes = base64Bytes(value)
    if (bytes?.length === 32 && (await crypto.subtle.verify('HMAC', key, bytes, signed)))
      return true
  }
  return false
}

export function createReplicateMediaProvider(
  options: ReplicateMediaProviderOptions,
): MediaProvider {
  const [model, version, ...rest] = options.modelId.split(':')
  const parts = (model ?? '').split('/')
  if (
    rest.length > 0 ||
    parts.length !== 2 ||
    parts.some((part) => !NAME.test(part)) ||
    (version !== undefined && !VERSION.test(version))
  )
    throw new AppError(
      'REPLICATE_INVALID_MODEL',
      'Expected a Replicate model as owner/name or owner/name:version',
    )
  const now = options.now ?? Date.now
  // 不能以 options 为 this 调用：Workers 的全局 fetch 会抛 Illegal invocation。
  const fetcher = options.fetch
  let webhookKey: Promise<CryptoKey> | undefined

  async function request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    if (!options.apiToken) notConfigured('API token')
    const submit = method === 'POST' && body !== undefined
    let response: Response
    try {
      response = await fetcher(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new ReplicateProviderError(
        submit ? 'ambiguous' : 'provider_error',
        'REPLICATE_TRANSPORT_ERROR',
        'Replicate request did not complete',
        { submissionOutcome: submit ? 'ambiguous' : undefined, causeName: errorName(error) },
      )
    }
    if (!response.ok) {
      // 分类按 D3：429 限流、401/403 鉴权、5xx 服务端、其余 4xx（含 422 参数校验）为请求被拒。
      // 提交的 5xx / 408 与 fal 一致视为「是否已受理不确定」，现有 Runner 据此不重提。
      const uncertain = submit && (response.status >= 500 || response.status === 408)
      throw new ReplicateProviderError(
        response.status === 408 && submit ? 'ambiguous' : failureKindFromStatus(response.status),
        'REPLICATE_HTTP_ERROR',
        `Replicate HTTP request failed (${response.status})`,
        {
          httpStatus: response.status,
          submissionOutcome: submit ? (uncertain ? 'ambiguous' : 'rejected') : undefined,
        },
      )
    }
    return response
  }

  async function prediction(
    response: Response,
    submission?: ReplicateSubmissionOutcome,
  ): Promise<Prediction> {
    let body: unknown
    try {
      body = await response.json()
    } catch {
      invalidResponse(submission)
    }
    const parsed = predictionSchema.safeParse(body)
    if (!parsed.success) invalidResponse(submission)
    return parsed.data
  }

  function jobPath(jobId: string): string {
    if (!predictionId.safeParse(jobId).success)
      throw new AppError('REPLICATE_INVALID_JOB', 'Invalid Replicate prediction ID')
    return `/v1/predictions/${jobId}`
  }

  function signingKey(): Promise<CryptoKey> {
    if (webhookKey) return webhookKey
    const key = importReplicateWebhookSecret(options.webhookSecret)
    webhookKey = key
    // 不缓存失败结果，避免一次异常让实例永久不可用。
    key.catch(() => {
      if (webhookKey === key) webhookKey = undefined
    })
    return key
  }

  return {
    id: 'replicate',
    // Replicate 创建预测没有幂等键；不确定时走现有「提交确认中」路径，不重提。
    capabilities: { idempotentSubmit: false },
    async submit(input) {
      if (input.modelId !== options.modelId)
        throw new AppError(
          'REPLICATE_INVALID_MODEL',
          'Model does not match this Replicate provider instance',
        )
      const webhook =
        input.webhookUrl === undefined
          ? {}
          : { webhook: input.webhookUrl, webhook_events_filter: ['completed'] }
      const response =
        version === undefined
          ? await request(`/v1/models/${parts[0]}/${parts[1]}/predictions`, 'POST', {
              input: input.params,
              ...webhook,
            })
          : await request('/v1/predictions', 'POST', {
              version: options.modelId,
              input: input.params,
              ...webhook,
            })
      return { jobId: (await prediction(response, 'ambiguous')).id }
    },
    async getStatus(jobId) {
      const result = await prediction(await request(jobPath(jobId), 'GET'))
      if (result.id !== jobId) invalidResponse()
      return toStatus(result)
    },
    async cancel(jobId) {
      await request(`${jobPath(jobId)}/cancel`, 'POST')
    },
    async parseWebhook(req, rawBody) {
      if (!(await verifyReplicateWebhook(await signingKey(), req.headers, rawBody, now())))
        invalidWebhook()
      let decoded: unknown
      try {
        decoded = JSON.parse(rawBody)
      } catch {
        invalidWebhook()
      }
      const parsed = predictionSchema.safeParse(decoded)
      if (!parsed.success) invalidWebhook()
      const status = toStatus(parsed.data)
      const jobId = parsed.data.id
      if (status.status === 'succeeded') return { jobId, result: status.result }
      if (status.status === 'failed') return { jobId, error: status.error }
      // 只订阅 completed，非终态回调不应出现；交给调用方查询原作业。
      return { jobId }
    },
  }
}
