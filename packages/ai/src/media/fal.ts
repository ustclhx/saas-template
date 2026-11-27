import { AppError } from '@saas/shared'
import { z } from 'zod'
import { type FailureKind, failureKindFromStatus, ProviderFailure } from '../failover/failure.ts'
import type { MediaError, MediaProvider, MediaResult, MediaStatus } from './provider.ts'

const QUEUE_ORIGIN = 'https://queue.fal.run'
const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json'
const JWKS_TTL_MS = 24 * 60 * 60 * 1000
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const file = z.object({
  url: z.url({ protocol: /^https$/ }),
  content_type: z.string().min(1).nullish(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().nonnegative().optional(),
})
const output = z
  .object({
    images: z.array(file).min(1).optional(),
    video: file.optional(),
  })
  .refine((value) => Boolean(value.images) !== Boolean(value.video))
const statusSchema = z.object({
  request_id: id,
  status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']),
  error: z.string().nullable().optional(),
  error_type: z.string().nullable().optional(),
})
const webhookSchema = z.object({
  request_id: id,
  gateway_request_id: id.optional(),
  status: z.enum(['OK', 'ERROR']),
  payload: z.unknown().optional(),
  error: z.string().nullable().optional(),
  error_type: z.string().nullable().optional(),
  payload_error: z.string().optional(),
})
const jwksSchema = z.object({
  keys: z.array(z.object({ x: z.string().regex(/^[a-zA-Z0-9_+/-]{43}=?$/) })).min(1),
})

export type FalSubmissionOutcome = 'ambiguous' | 'rejected'

/*
 * fal 失败分类（add-media-provider-fallback 决策 D3）。错误类型取值出自官方文档，核对日期 2026-11-27：
 * https://fal.ai/docs/model-apis/errors （模型级 detail[].type 与请求级 error_type / X-Fal-Error-Type）
 * https://fal.ai/docs/model-apis/model-endpoints/queue （COMPLETED 状态的 error / error_type）
 * https://fal.ai/docs/model-apis/model-endpoints/webhooks （status=ERROR 的 error 与 payload.detail）
 */

/** 内容审核：fal 自身或合作方的安全过滤拒绝，无单独的 NSFW 类型。 */
const FAL_CONTENT_POLICY_TYPES: ReadonlySet<string> = new Set(['content_policy_violation'])

/** 服务端与基础设施错误（文档中 500 / 502 / 503 / 504），换服务商可能成功。 */
const FAL_PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  'internal_server_error',
  'generation_timeout',
  'downstream_service_error',
  'downstream_service_unavailable',
  'request_timeout',
  'startup_timeout',
  'runner_scheduling_failure',
  'runner_connection_timeout',
  'runner_disconnected',
  'runner_connection_refused',
  'runner_connection_error',
  'runner_incomplete_response',
  'runner_server_error',
  'internal_error',
])

/** 请求本身的问题（文档中 400 / 422，不可重试）；换服务商同样会失败或产出不同语义。 */
const FAL_REJECTED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'bad_request',
  'no_media_generated',
  'value_error',
  'input_value_error',
  'missing',
  'image_too_small',
  'image_too_large',
  'image_load_error',
  'file_download_error',
  'face_detection_error',
  'file_too_large',
  'greater_than',
  'greater_than_equal',
  'less_than',
  'less_than_equal',
  'multiple_of',
  'sequence_too_short',
  'sequence_too_long',
  'one_of',
  'feature_not_supported',
  'invalid_archive',
  'archive_file_count_below_minimum',
  'archive_file_count_exceeds_maximum',
  'audio_duration_too_long',
  'audio_duration_too_short',
  'unsupported_audio_format',
  'unsupported_image_format',
  'unsupported_video_format',
  'video_duration_too_long',
  'video_duration_too_short',
])

/**
 * 按 fal 错误类型分类；旧格式带点号后缀（如 `value_error.missing`）取前缀。
 * 未知类型按 provider_error（决策 D3「未知错误按 provider_error」）。
 */
export function falErrorTypeKind(type: string): FailureKind {
  const base = type.split('.')[0] ?? type
  if (FAL_CONTENT_POLICY_TYPES.has(base)) return 'content_policy'
  if (FAL_REJECTED_INPUT_TYPES.has(base)) return 'rejected_input'
  if (FAL_PROVIDER_ERROR_TYPES.has(base)) return 'provider_error'
  return 'provider_error'
}

/**
 * HTTP 请求失败的分类：可能已受理的提交一律 ambiguous（不切换，避免重复生成）；
 * 其余按状态码：429 限流、401/403 鉴权、5xx 与网络异常服务端错误、400/422 等请求被拒。
 */
function falRequestKind(
  httpStatus: number | undefined,
  submissionOutcome: FalSubmissionOutcome | undefined,
): FailureKind {
  if (submissionOutcome === 'ambiguous') return 'ambiguous'
  return failureKindFromStatus(httpStatus)
}

const detailSchema = z.object({
  detail: z.array(z.object({ type: z.string().min(1) }).loose()).min(1),
})

/** 生成失败（队列状态或回调）的分类：优先 error_type，其次 payload.detail[].type，再次错误文本中的状态码。 */
function falJobErrorKind(
  errorType: string | null | undefined,
  payload: unknown,
  error?: string | null,
) {
  const types = [
    ...(errorType ? [errorType] : []),
    ...(detailSchema.safeParse(payload).data?.detail.map((item) => item.type) ?? []),
  ]
  const kinds = types.map(falErrorTypeKind)
  // 多个类型并存时取最不该切换的：内容审核优先于参数错误，再到服务端错误。
  for (const kind of ['content_policy', 'rejected_input', 'provider_error'] as const)
    if (kinds.includes(kind)) return kind
  const status = /status code:?\s*(\d{3})/i.exec(error ?? '')?.[1]
  return status ? failureKindFromStatus(Number(status)) : 'provider_error'
}

function falJobError(
  errorType: string | null | undefined,
  message: string,
  payload?: unknown,
): MediaError {
  return {
    code: errorType ?? 'FAL_GENERATION_FAILED',
    message,
    kind: falJobErrorKind(errorType, payload, message),
  }
}

/**
 * 不附带上游响应或网络错误，避免把请求参数与密钥泄露给客户端或日志。
 * causeName 只保留底层异常的类名（如 TypeError / TimeoutError），用于定位传输失败原因。
 * `kind` 为失败分类（ProviderFailure），供媒体切换判断。
 */
export class FalProviderError extends ProviderFailure {
  readonly httpStatus: number | undefined
  readonly submissionOutcome: FalSubmissionOutcome | undefined
  readonly causeName: string | undefined

  constructor(
    code: string,
    message: string,
    httpStatus?: number,
    submissionOutcome?: FalSubmissionOutcome,
    causeName?: string,
  ) {
    super(falRequestKind(httpStatus, submissionOutcome), code, message, { status: 502 })
    this.httpStatus = httpStatus
    this.submissionOutcome = submissionOutcome
    this.causeName = causeName
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

// workerd 不支持 redirect: 'error'（RequestInit 校验直接抛 TypeError，请求不会发出）；
// 改用 manual 并由 !response.ok 拒绝 3xx，效果同样是不跟随重定向。
const NO_REDIRECT = 'manual' as const

export interface FalMediaProviderOptions {
  apiKey: string
  /** 每个任务按其 modelId 重建实例，无需保留进程内 jobId → model 映射。 */
  modelId: string
  fetch: typeof fetch
  now?: () => number
}

function invalidResponse(submission?: FalSubmissionOutcome): never {
  throw new FalProviderError(
    'FAL_INVALID_RESPONSE',
    'Invalid fal.ai response',
    undefined,
    submission,
  )
}

function parse<T>(schema: z.ZodType<T>, value: unknown, submission?: FalSubmissionOutcome): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) invalidResponse(submission)
  return parsed.data
}

function mediaResult(value: unknown): MediaResult {
  const data = parse(output, value)
  const files = data.images ?? (data.video ? [data.video] : [])
  const outputs = files.map((item) => {
    // 类型缺失时只根据明确的文件扩展名推导，不能把未知格式伪装成 JPEG/MP4。
    const extension = new URL(item.url).pathname.split('.').pop()?.toLowerCase()
    const mime =
      item.content_type ??
      (
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          mp4: 'video/mp4',
        } as Record<string, string>
      )[extension ?? '']
    if (!mime || !(data.images ? mime.startsWith('image/') : mime.startsWith('video/')))
      invalidResponse()
    return {
      url: item.url,
      mime,
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
      ...(item.duration === undefined ? {} : { durationSec: item.duration }),
    }
  })
  return {
    outputs,
    ...(data.images
      ? { usage: { images: data.images.length } }
      : data.video?.duration === undefined
        ? {}
        : { usage: { seconds: data.video.duration } }),
  }
}

function invalidWebhook(): never {
  throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid fal.ai webhook', { status: 400 })
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 队列路径规则与 fal 官方 JS SDK 的 parseEndpointId / queue.status 保持一致。 */
export function createFalMediaProvider(options: FalMediaProviderOptions): MediaProvider {
  const parts = options.modelId.split('/')
  const baseLength = parts[0] === 'workflows' || parts[0] === 'comfy' ? 3 : 2
  if (
    parts.length < baseLength ||
    parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part))
  ) {
    throw new AppError('FAL_INVALID_MODEL', 'Expected a fal.ai model endpoint ID')
  }
  const baseModelId = parts.slice(0, baseLength).join('/')
  const now = options.now ?? Date.now
  // 不能以 options 为 this 调用：Workers 的全局 fetch 会抛 Illegal invocation，请求根本不会发出。
  const fetcher = options.fetch
  let cachedKeys: { keys: CryptoKey[]; expiresAt: number } | undefined

  async function request(
    url: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
  ): Promise<Response> {
    if (!options.apiKey)
      throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'fal.ai API key is not configured', {
        status: 503,
      })
    let response: Response
    try {
      response = await fetcher(url, {
        method,
        headers: { Authorization: `Key ${options.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new FalProviderError(
        'FAL_TRANSPORT_ERROR',
        'fal.ai request did not complete',
        undefined,
        method === 'POST' ? 'ambiguous' : undefined,
        errorName(error),
      )
    }
    if (!response.ok) {
      throw new FalProviderError(
        'FAL_HTTP_ERROR',
        `fal.ai HTTP request failed (${response.status})`,
        response.status,
        method === 'POST'
          ? response.status >= 500 || response.status === 408
            ? 'ambiguous'
            : 'rejected'
          : undefined,
      )
    }
    return response
  }

  async function json(response: Response, submission?: FalSubmissionOutcome): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      invalidResponse(submission)
    }
  }

  function jobPath(jobId: string): string {
    if (!id.safeParse(jobId).success) throw new AppError('FAL_INVALID_JOB', 'Invalid fal.ai job ID')
    return `${QUEUE_ORIGIN}/${baseModelId}/requests/${jobId}`
  }

  async function publicKeys(): Promise<CryptoKey[]> {
    if (cachedKeys && cachedKeys.expiresAt > now()) return cachedKeys.keys
    let response: Response
    try {
      // JWKS 请求不携带 API key；也不允许回调提供公钥地址。
      response = await fetcher(JWKS_URL, {
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new FalProviderError(
        'FAL_JWKS_UNAVAILABLE',
        'fal.ai webhook keys are unavailable',
        undefined,
        undefined,
        errorName(error),
      )
    }
    if (!response.ok)
      throw new FalProviderError(
        'FAL_JWKS_UNAVAILABLE',
        'fal.ai webhook keys are unavailable',
        response.status,
      )
    const { keys } = parse(jwksSchema, await json(response))
    const imported = await Promise.all(
      keys.map(async ({ x }) => {
        const bytes = Uint8Array.from(
          atob(`${x.replace(/=$/, '').replaceAll('-', '+').replaceAll('_', '/')}=`),
          (char) => char.charCodeAt(0),
        )
        return crypto.subtle.importKey('raw', bytes, 'Ed25519', false, ['verify'])
      }),
    )
    cachedKeys = { keys: imported, expiresAt: now() + JWKS_TTL_MS }
    return imported
  }

  return {
    id: 'fal',
    // 2026-10-12 实测同一 Idempotency-Key 与请求体仍生成两个作业；证据见夹具 README。
    capabilities: { idempotentSubmit: false },
    async submit(input) {
      if (input.modelId !== options.modelId)
        throw new AppError(
          'FAL_INVALID_MODEL',
          'Model does not match this fal.ai provider instance',
        )
      const url = new URL(`${QUEUE_ORIGIN}/${options.modelId}`)
      if (input.webhookUrl !== undefined) url.searchParams.set('fal_webhook', input.webhookUrl)
      const response = await request(url.toString(), 'POST', input.params)
      const result = parse(
        z.object({ request_id: id }),
        await json(response, 'ambiguous'),
        'ambiguous',
      )
      return { jobId: result.request_id }
    },
    async getStatus(jobId): Promise<MediaStatus> {
      const path = jobPath(jobId)
      const status = parse(statusSchema, await json(await request(`${path}/status`, 'GET')))
      if (status.request_id !== jobId) invalidResponse()
      if (status.status === 'IN_QUEUE') return { status: 'queued' }
      if (status.status === 'IN_PROGRESS') return { status: 'running' }
      if (status.error)
        return { status: 'failed', error: falJobError(status.error_type, status.error) }
      return { status: 'succeeded', result: mediaResult(await json(await request(path, 'GET'))) }
    },
    async cancel(jobId) {
      await request(`${jobPath(jobId)}/cancel`, 'PUT')
    },
    async parseWebhook(req, rawBody) {
      const requestId = req.headers.get('x-fal-webhook-request-id')
      const userId = req.headers.get('x-fal-webhook-user-id')
      const timestamp = req.headers.get('x-fal-webhook-timestamp')
      const signature = req.headers.get('x-fal-webhook-signature')
      if (
        !requestId ||
        !userId ||
        !timestamp ||
        !signature ||
        !/^\d+$/.test(timestamp) ||
        !/^[a-fA-F0-9]{128}$/.test(signature) ||
        Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > 300
      )
        invalidWebhook()
      const encoder = new TextEncoder()
      const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(rawBody)))
      const message = encoder.encode([requestId, userId, timestamp, hash].join('\n'))
      const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) =>
        Number.parseInt(pair, 16),
      )
      let valid = false
      for (const key of await publicKeys()) {
        if (await crypto.subtle.verify('Ed25519', key, bytes, message)) {
          valid = true
          break
        }
      }
      if (!valid) invalidWebhook()
      let decoded: unknown
      try {
        decoded = JSON.parse(rawBody)
      } catch {
        invalidWebhook()
      }
      const parsed = webhookSchema.safeParse(decoded)
      if (!parsed.success) invalidWebhook()
      const payload = parsed.data
      // fal 的内部重试可能改变 gateway_request_id；jobId 始终取队列 request_id。
      if (requestId !== payload.request_id && requestId !== payload.gateway_request_id)
        invalidWebhook()
      if (payload.status === 'ERROR') {
        return {
          jobId: payload.request_id,
          error: falJobError(
            payload.error_type,
            payload.error ?? 'fal.ai generation failed',
            payload.payload,
          ),
        }
      }
      // 序列化失败的回调仍经验签，交给调用方轮询，不把缺失结果当作生成失败。
      if (payload.payload_error && payload.payload == null) return { jobId: payload.request_id }
      return { jobId: payload.request_id, result: mediaResult(payload.payload) }
    },
  }
}
