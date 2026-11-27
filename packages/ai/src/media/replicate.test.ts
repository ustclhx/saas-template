import { describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures/replicate.documented.json'
import {
  createReplicateMediaProvider,
  importReplicateWebhookSecret,
  ReplicateProviderError,
  verifyReplicateWebhook,
} from './replicate.ts'

const modelId = 'black-forest-labs/flux-schnell'
const version = 'a'.repeat(64)
const jobId = fixtures.prediction.id
const now = 1_800_000_000_000
const secret = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD'
const input = { modelId, params: { prompt: 'a red square' }, idempotencyKey: 'task-fixture' }
const webhookUrl = 'https://example.com/api/webhooks/media/replicate?task=t&sig=placeholder'

function setup(responses: Response[], model = modelId) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const response of responses) fetch.mockResolvedValueOnce(response)
  return {
    fetch,
    provider: createReplicateMediaProvider({
      apiToken: 'test-placeholder',
      webhookSecret: secret,
      modelId: model,
      fetch,
      now: () => now,
    }),
  }
}

function prediction(overrides: Record<string, unknown> = {}) {
  return { ...fixtures.prediction, ...overrides }
}

async function sign(body: string, id: string, timestamp: number, key = secret) {
  const raw = Uint8Array.from(atob(key.slice(6)), (char) => char.charCodeAt(0))
  const hmac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const mac = await crypto.subtle.sign(
    'HMAC',
    hmac,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  )
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`
}

async function webhook(body: unknown, options: { timestamp?: number; signature?: string } = {}) {
  const raw = JSON.stringify(body)
  const timestamp = options.timestamp ?? now / 1000
  const signature = options.signature ?? (await sign(raw, 'msg_fixture', timestamp))
  return {
    raw,
    req: new Request(webhookUrl, {
      method: 'POST',
      headers: {
        'webhook-id': 'msg_fixture',
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signature,
      },
      body: raw,
    }),
  }
}

describe('Replicate 提交', () => {
  it('官方模型走 models/{owner}/{name}/predictions，带 completed 回调过滤且不声称幂等', async () => {
    const { provider, fetch } = setup([
      Response.json(prediction({ status: 'starting', output: null }), { status: 201 }),
    ])
    expect(await provider.submit({ ...input, webhookUrl })).toEqual({ jobId })
    expect(provider.capabilities.idempotentSubmit).toBe(false)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',
    )
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(JSON.parse(String(init?.body))).toEqual({
      input: input.params,
      webhook: webhookUrl,
      webhook_events_filter: ['completed'],
    })
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-placeholder')
    expect(headers.has('idempotency-key')).toBe(false)
    expect(headers.has('prefer')).toBe(false)
  })

  it('带版本号的模型走 /v1/predictions 并传 owner/name:version', async () => {
    const model = `${modelId}:${version}`
    const { provider, fetch } = setup([Response.json(prediction({ status: 'starting' }))], model)
    expect(await provider.submit({ ...input, modelId: model })).toEqual({ jobId })
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://api.replicate.com/v1/predictions')
    expect(JSON.parse(String(init?.body))).toEqual({ version: model, input: input.params })
  })

  it('拒绝不合规的模型 ID 与不属于本实例的模型', async () => {
    for (const bad of ['flux', 'a/b/c', 'a/b:short', '../x/y', `a/b:${version}:x`])
      expect(() =>
        createReplicateMediaProvider({ apiToken: 't', webhookSecret: secret, modelId: bad, fetch }),
      ).toThrow('Expected a Replicate model')
    const { provider } = setup([])
    await expect(provider.submit({ ...input, modelId: 'other/model' })).rejects.toMatchObject({
      code: 'REPLICATE_INVALID_MODEL',
    })
  })

  it('注入的 fetch 不以 options 为 this 调用（Workers 全局 fetch 会抛 Illegal invocation）', async () => {
    const receivers: unknown[] = []
    const fetch = function (this: unknown) {
      receivers.push(this)
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(Response.json(prediction({ status: 'starting' })))
    } as typeof globalThis.fetch
    const provider = createReplicateMediaProvider({
      apiToken: 't',
      webhookSecret: secret,
      modelId,
      fetch,
    })
    expect(await provider.submit(input)).toEqual({ jobId })
    expect(receivers).toHaveLength(1)
  })
})

describe('Replicate 错误分类', () => {
  it.each([
    [429, 'rate_limited', 'rejected'],
    [401, 'auth', 'rejected'],
    [403, 'auth', 'rejected'],
    [422, 'rejected_input', 'rejected'],
    [404, 'rejected_input', 'rejected'],
    [500, 'provider_error', 'ambiguous'],
    [503, 'provider_error', 'ambiguous'],
    [408, 'ambiguous', 'ambiguous'],
  ] as const)('提交 HTTP %i → %s / %s，错误不含上游正文', async (status, kind, outcome) => {
    const { provider } = setup([Response.json(fixtures.throttled, { status })])
    const error = await provider.submit(input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReplicateProviderError)
    expect(error).toMatchObject({ kind, httpStatus: status, submissionOutcome: outcome })
    expect(String((error as Error).message)).not.toContain('throttled')
  })

  it('提交网络异常、超时与无法解析的回包视为不确定受理', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError('net'))
    const provider = createReplicateMediaProvider({
      apiToken: 't',
      webhookSecret: secret,
      modelId,
      fetch,
    })
    await expect(provider.submit(input)).rejects.toMatchObject({
      kind: 'ambiguous',
      submissionOutcome: 'ambiguous',
      causeName: 'TypeError',
    })
    const { provider: garbled } = setup([new Response('not json', { status: 201 })])
    await expect(garbled.submit(input)).rejects.toMatchObject({
      code: 'REPLICATE_INVALID_RESPONSE',
      kind: 'ambiguous',
      submissionOutcome: 'ambiguous',
    })
  })

  it('3xx 不跟随重定向，按失败处理', async () => {
    const { provider } = setup([
      new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    ])
    await expect(provider.getStatus(jobId)).rejects.toMatchObject({ httpStatus: 302 })
  })

  it('缺少 token 时报告未配置', async () => {
    const provider = createReplicateMediaProvider({
      apiToken: '',
      webhookSecret: secret,
      modelId,
      fetch,
    })
    await expect(provider.submit(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_NOT_CONFIGURED',
    })
  })
})

describe('Replicate 状态查询与取消', () => {
  it('starting / processing 映射为 running，查询地址用预测 ID', async () => {
    const { provider, fetch } = setup([
      Response.json(prediction({ status: 'starting', output: null })),
      Response.json(prediction({ status: 'processing', output: null })),
    ])
    expect(await provider.getStatus(jobId)).toEqual({ status: 'running' })
    expect(await provider.getStatus(jobId)).toEqual({ status: 'running' })
    expect(fetch.mock.calls[0]?.[0]).toBe(fixtures.prediction.urls.get)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual' })
  })

  it('succeeded 返回白名单内产出与按扩展名推导的 mime（数组与单个字符串）', async () => {
    const video = 'https://replicate.delivery/xezq/fixture/out.mp4'
    const { provider } = setup([
      Response.json(prediction()),
      Response.json(prediction({ output: video })),
    ])
    expect(await provider.getStatus(jobId)).toEqual({
      status: 'succeeded',
      result: {
        outputs: [{ url: fixtures.prediction.output[0], mime: 'image/webp' }],
        usage: { images: 1 },
      },
    })
    // 运行时间不能当作视频时长，视频不报告 usage。
    expect(await provider.getStatus(jobId)).toEqual({
      status: 'succeeded',
      result: { outputs: [{ url: video, mime: 'video/mp4' }] },
    })
  })

  it.each([
    ['非白名单主机', ['https://evil.example/out.png']],
    ['子域名未登记', ['https://pbxt.replicate.delivery/out.png']],
    ['http 协议', ['http://replicate.delivery/out.png']],
    ['未知扩展名', ['https://replicate.delivery/out.bin']],
    ['图片视频混合', ['https://replicate.delivery/a.png', 'https://replicate.delivery/b.mp4']],
    ['非 URL 产出', { text: 'hello' }],
  ])('拒绝产出：%s', async (_name, output) => {
    const { provider } = setup([Response.json(prediction({ output }))])
    await expect(provider.getStatus(jobId)).rejects.toMatchObject({
      code: 'REPLICATE_INVALID_RESPONSE',
    })
  })

  it.each([
    [
      'NSFW content detected. Try running it again, or try a different prompt.',
      'REPLICATE_CONTENT_POLICY',
      'content_policy',
    ],
    [
      'The input or output was flagged as sensitive. Please try again with different inputs. (E005)',
      'REPLICATE_CONTENT_POLICY',
      'content_policy',
    ],
    ['Model Out of Memory (E1001)', 'REPLICATE_E1001', 'provider_error'],
    ['CUDA error: device-side assert triggered', 'REPLICATE_GENERATION_FAILED', 'provider_error'],
  ] as const)('failed「%s」→ %s / %s', async (error, code, kind) => {
    const { provider } = setup([
      Response.json(prediction({ status: 'failed', output: null, error })),
    ])
    expect(await provider.getStatus(jobId)).toEqual({
      status: 'failed',
      error: { code, message: error, kind },
    })
  })

  it('canceled、aborted 与产出已删除均为失败', async () => {
    const { provider } = setup([
      Response.json(prediction({ status: 'canceled', output: null })),
      Response.json(prediction({ status: 'aborted', output: null })),
      Response.json(prediction({ output: null, data_removed: true })),
    ])
    for (const code of ['REPLICATE_CANCELED', 'REPLICATE_ABORTED', 'REPLICATE_OUTPUT_REMOVED'])
      expect(await provider.getStatus(jobId)).toMatchObject({
        status: 'failed',
        error: { code, kind: 'provider_error' },
      })
  })

  it('查询回包 ID 不一致或 ID 含非法字符时拒绝', async () => {
    const { provider, fetch } = setup([Response.json(prediction({ id: 'otherid' }))])
    await expect(provider.getStatus(jobId)).rejects.toMatchObject({
      code: 'REPLICATE_INVALID_RESPONSE',
    })
    await expect(provider.getStatus('../account')).rejects.toMatchObject({
      code: 'REPLICATE_INVALID_JOB',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('查询的 HTTP 错误按状态分类且不带提交结果', async () => {
    const { provider } = setup([Response.json(fixtures.throttled, { status: 429 })])
    await expect(provider.getStatus(jobId)).rejects.toMatchObject({
      kind: 'rate_limited',
      submissionOutcome: undefined,
    })
  })

  it('取消调用 POST cancel 地址，失败时抛出', async () => {
    const { provider, fetch } = setup([
      Response.json(prediction({ status: 'canceled' })),
      new Response(null, { status: 500 }),
    ])
    await provider.cancel?.(jobId)
    expect(fetch.mock.calls[0]?.[0]).toBe(fixtures.prediction.urls.cancel)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined()
    await expect(provider.cancel?.(jobId)).rejects.toMatchObject({
      kind: 'provider_error',
      submissionOutcome: undefined,
    })
  })
})

describe('Replicate 回调验签', () => {
  it('Standard Webhooks 官方测试向量通过，改动一个字符即失败', async () => {
    const vector = fixtures.webhookVector
    const key = await importReplicateWebhookSecret(vector.secret)
    const headers = (signature: string) =>
      new Headers({
        'webhook-id': vector.id,
        'webhook-timestamp': String(vector.timestamp),
        'webhook-signature': signature,
      })
    const at = vector.timestamp * 1000
    expect(await verifyReplicateWebhook(key, headers(vector.signature), vector.payload, at)).toBe(
      true,
    )
    // 多个签名以空格分隔，任一 v1 匹配即可；其他版本前缀忽略。
    expect(
      await verifyReplicateWebhook(
        key,
        headers(`v2,${vector.signature.slice(3)} ${vector.tamperedSignature} ${vector.signature}`),
        vector.payload,
        at,
      ),
    ).toBe(true)
    expect(
      await verifyReplicateWebhook(key, headers(vector.tamperedSignature), vector.payload, at),
    ).toBe(false)
    expect(
      await verifyReplicateWebhook(key, headers(vector.signature), `${vector.payload} `, at),
    ).toBe(false)
    // 超过 5 分钟（含未来时间）拒绝；恰好 5 分钟仍接受。
    expect(
      await verifyReplicateWebhook(key, headers(vector.signature), vector.payload, at + 301_000),
    ).toBe(false)
    expect(
      await verifyReplicateWebhook(key, headers(vector.signature), vector.payload, at - 301_000),
    ).toBe(false)
    expect(
      await verifyReplicateWebhook(key, headers(vector.signature), vector.payload, at + 300_000),
    ).toBe(true)
  })

  it('验签通过后解析成功回调为结果', async () => {
    const { provider, fetch } = setup([])
    const { req, raw } = await webhook(prediction())
    expect(await provider.parseWebhook(req, raw)).toEqual({
      jobId,
      result: {
        outputs: [{ url: fixtures.prediction.output[0], mime: 'image/webp' }],
        usage: { images: 1 },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('失败回调带分类，非终态回调只返回 jobId', async () => {
    const { provider } = setup([])
    const failed = await webhook(
      prediction({ status: 'failed', output: null, error: 'NSFW content detected.' }),
    )
    expect(await provider.parseWebhook(failed.req, failed.raw)).toEqual({
      jobId,
      error: {
        code: 'REPLICATE_CONTENT_POLICY',
        message: 'NSFW content detected.',
        kind: 'content_policy',
      },
    })
    const running = await webhook(prediction({ status: 'processing', output: null }))
    expect(await provider.parseWebhook(running.req, running.raw)).toEqual({ jobId })
  })

  it('签名错误、换密钥签名、时间戳过期与缺少头部均返回 400，且不解析正文', async () => {
    const { provider } = setup([])
    const body = prediction()
    const raw = JSON.stringify(body)
    const ts = now / 1000
    const cases = [
      await webhook(body, { signature: fixtures.webhookVector.tamperedSignature }),
      await webhook(body, {
        signature: await sign(raw, 'msg_fixture', ts, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'),
      }),
      await webhook(body, {
        timestamp: ts - 301,
        signature: await sign(raw, 'msg_fixture', ts - 301),
      }),
      { raw, req: new Request(webhookUrl, { method: 'POST', body: raw }) },
    ]
    for (const { req, raw: payload } of cases)
      await expect(provider.parseWebhook(req, payload)).rejects.toMatchObject({
        code: 'MEDIA_WEBHOOK_INVALID',
        status: 400,
      })
    // 签名有效但正文被替换：验的是原始正文，篡改后同样拒绝。
    const valid = await webhook(body)
    await expect(
      provider.parseWebhook(valid.req, raw.replace('succeeded', 'failed')),
    ).rejects.toMatchObject({
      code: 'MEDIA_WEBHOOK_INVALID',
    })
  })

  it('签名正确但正文不是预测对象时返回 400', async () => {
    const { provider } = setup([])
    const { req, raw } = await webhook({ test: 1 })
    await expect(provider.parseWebhook(req, raw)).rejects.toMatchObject({
      code: 'MEDIA_WEBHOOK_INVALID',
    })
  })

  it('webhook 密钥格式错误视为未配置（503），不是伪造回调', async () => {
    const provider = createReplicateMediaProvider({
      apiToken: 't',
      webhookSecret: 'not-a-secret',
      modelId,
      fetch,
      now: () => now,
    })
    const { req, raw } = await webhook(prediction())
    await expect(provider.parseWebhook(req, raw)).rejects.toMatchObject({
      code: 'AI_PROVIDER_NOT_CONFIGURED',
      status: 503,
    })
  })
})
