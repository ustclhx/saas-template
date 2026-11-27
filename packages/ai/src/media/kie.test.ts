import { describe, expect, it, vi } from 'vitest'
import { canFailover } from '../failover/failure.ts'
import fixtures from './fixtures/kie.documented.json'
import {
  createKieMediaProvider,
  isKieUnifiedModel,
  KIE_OUTPUT_HOSTS,
  KieProviderError,
  kieFailureKind,
} from './kie.ts'
import { getMediaOutputHosts, requireMediaProviderDefinition } from './registry.ts'

const modelId = 'seedream/4.5-text-to-image'
const secret = 'test-placeholder-hmac-key'
const timestamp = fixtures.callbackHeaders['X-Webhook-Timestamp']
const now = Number(timestamp) * 1000
const jobId = fixtures.recordSuccess.data.taskId
const input = { modelId, params: { prompt: 'a red square' }, idempotencyKey: 'task-fixture' }

function setup(bodies: unknown[], statuses: number[] = []) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const [index, body] of bodies.entries())
    fetch.mockResolvedValueOnce(Response.json(body, { status: statuses[index] ?? 200 }))
  return {
    fetch,
    provider: createKieMediaProvider({
      apiKey: 'test-placeholder',
      webhookSecret: secret,
      modelId,
      fetch,
      now: () => now,
    }),
  }
}

async function sign(taskId: string, ts: string, key = secret): Promise<string> {
  const encoder = new TextEncoder()
  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', imported, encoder.encode(`${taskId}.${ts}`))
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
}

function webhook(body: unknown, headers: Record<string, string>) {
  const raw = JSON.stringify(body)
  return [
    new Request('https://example.com/cb', { method: 'POST', headers, body: raw }),
    raw,
  ] as const
}

async function rejection(promise: Promise<unknown>): Promise<KieProviderError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(KieProviderError)
  return error as KieProviderError
}

describe('kie.ai 统一任务接口（文档样例夹具）', () => {
  it('提交 createTask：model + input + callBackUrl，Bearer 鉴权，不跟随重定向，不声称幂等', async () => {
    const { provider, fetch } = setup([fixtures.submit])
    const webhookUrl = 'https://example.com/webhook?task=task-fixture&sig=test-placeholder'
    expect(await provider.submit({ ...input, webhookUrl })).toEqual({
      jobId: fixtures.submit.data.taskId,
    })
    expect(provider.capabilities.idempotentSubmit).toBe(false)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(String(url)).toBe('https://api.kie.ai/api/v1/jobs/createTask')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: modelId,
      input: input.params,
      callBackUrl: webhookUrl,
    })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-placeholder')
  })

  it('提交的模型必须与实例一致', async () => {
    const { provider, fetch } = setup([])
    await expect(provider.submit({ ...input, modelId: 'other/model' })).rejects.toThrow(
      'does not match',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('HTTP 200 + body code 的明确拒绝按分类返回，不带上游正文', async () => {
    for (const [body, kind, status] of [
      [fixtures.unauthorized, 'auth', 401],
      [{ code: 402, msg: 'Insufficient credits' }, 'auth', 402],
      [fixtures.rateLimited, 'rate_limited', 429],
      [{ code: 422, msg: 'aspect_ratio is invalid' }, 'rejected_input', 422],
      [{ code: 455, msg: 'maintenance' }, 'provider_error', 455],
    ] as const) {
      const error = await rejection(setup([body]).provider.submit(input))
      expect(error).toMatchObject({
        kind,
        httpStatus: status,
        submissionOutcome: 'rejected',
        code: 'KIE_API_ERROR',
      })
      expect(error.message).not.toContain(body.msg)
    }
  })

  it('无法确定是否入队（传输失败、HTTP 5xx、body code 500、回包无效）按 ambiguous，不可切换', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('net'))
    const cases = [
      createKieMediaProvider({ apiKey: 'k', webhookSecret: secret, modelId, fetch: transport }),
      setup([{}], [502]).provider,
      setup([fixtures.serverError]).provider,
      setup([{ code: 200, msg: 'success', data: {} }]).provider,
    ]
    for (const provider of cases) {
      const error = await rejection(provider.submit(input))
      expect(error.kind).toBe('ambiguous')
      expect(error.submissionOutcome).toBe('ambiguous')
      expect(canFailover(error.kind)).toBe(false)
    }
  })

  it('HTTP 层 4xx 按状态分类且为明确拒绝', async () => {
    const error = await rejection(setup([{}], [429]).provider.submit(input))
    expect(error).toMatchObject({ kind: 'rate_limited', submissionOutcome: 'rejected' })
  })

  it('recordInfo 映射排队 / 运行 / 成功（图片与视频）', async () => {
    const { provider, fetch } = setup([
      {
        ...fixtures.recordGenerating,
        data: { ...fixtures.recordGenerating.data, state: 'waiting' },
      },
      fixtures.recordGenerating,
      fixtures.recordSuccess,
    ])
    expect(await provider.getStatus(jobId)).toEqual({ status: 'queued' })
    expect(await provider.getStatus(jobId)).toEqual({ status: 'running' })
    expect(await provider.getStatus(jobId)).toEqual({
      status: 'succeeded',
      result: {
        outputs: [
          {
            url: 'https://tempfile.aiquickdraw.com/p/23f9f748b6ab725118c312fe44966846_1_1786415056_7121.jpg',
            mime: 'image/jpeg',
          },
        ],
        usage: { images: 1 },
      },
    })
    const url = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(url.origin + url.pathname).toBe('https://api.kie.ai/api/v1/jobs/recordInfo')
    expect(url.searchParams.get('taskId')).toBe(jobId)

    const videoId = fixtures.recordVideoSuccess.data.taskId
    const video = setup([fixtures.recordVideoSuccess]).provider
    // 视频不报告时长：kie 不返回时长，不能用运行时间计费。
    expect(await video.getStatus(videoId)).toEqual({
      status: 'succeeded',
      result: {
        outputs: [
          {
            url: 'https://tempfile.aiquickdraw.com/k/1f0176644624b187c7f6add97986875d_1_1792669217_8488.mp4',
            mime: 'video/mp4',
          },
        ],
      },
    })
  })

  it('作业失败按 failCode 分类，failMsg 不写入错误', async () => {
    const failed = (failCode: string, failMsg: string) => ({
      ...fixtures.recordFail,
      data: { ...fixtures.recordFail.data, failCode, failMsg },
    })
    const cases = [
      [fixtures.recordFail, 'provider_error'],
      [failed('400', 'image size too large'), 'rejected_input'],
      [failed('400', 'Content flagged as sensitive by moderation'), 'content_policy'],
      [failed('429', 'busy'), 'rate_limited'],
      [failed('', ''), 'provider_error'],
    ] as const
    for (const [body, kind] of cases) {
      const status = await setup([body]).provider.getStatus(jobId)
      expect(status).toMatchObject({
        status: 'failed',
        error: { code: 'KIE_GENERATION_FAILED', kind },
      })
      if (status.status === 'failed')
        expect(status.error.message).not.toContain(body.data.failMsg || '<')
    }
  })

  it('查询错误：任务不存在、taskId 不一致与非法 taskId', async () => {
    const missing = await rejection(setup([fixtures.recordNotFound]).provider.getStatus(jobId))
    expect(missing).toMatchObject({ kind: 'rejected_input', httpStatus: 422 })
    expect(missing.submissionOutcome).toBeUndefined()
    await expect(setup([fixtures.recordSuccess]).provider.getStatus('other_task')).rejects.toThrow(
      'Invalid kie.ai response',
    )
    const { provider, fetch } = setup([])
    await expect(provider.getStatus('../x')).rejects.toThrow('Invalid kie.ai task ID')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('产出只接受 https、白名单主机与已知扩展名，且同一任务种类一致', async () => {
    const withUrls = (resultUrls: string[]) => ({
      ...fixtures.recordSuccess,
      data: { ...fixtures.recordSuccess.data, resultJson: JSON.stringify({ resultUrls }) },
    })
    for (const urls of [
      ['http://tempfile.aiquickdraw.com/p/a.png'],
      ['https://evil.example.com/p/a.png'],
      ['https://tempfile.aiquickdraw.com.evil.com/p/a.png'],
      ['https://tempfile.aiquickdraw.com/p/a'],
      ['https://tempfile.aiquickdraw.com/p/a.png', 'https://tempfile.aiquickdraw.com/p/b.mp4'],
      [],
    ])
      await expect(setup([withUrls(urls)]).provider.getStatus(jobId)).rejects.toThrow(
        'Invalid kie.ai response',
      )
    const ok = await setup([
      withUrls([
        'https://file.aiquickdraw.com/s/a.PNG',
        'https://tempfile.aiquickdraw.com/x/b.webp',
      ]),
    ]).provider.getStatus(jobId)
    expect(ok).toMatchObject({ status: 'succeeded', result: { usage: { images: 2 } } })
  })
})

describe('kie.ai 回调验签', () => {
  it('签名正确时只返回 jobId（签名不覆盖正文，结果以查询为准）', async () => {
    const { provider } = setup([])
    for (const body of [fixtures.callbackSuccess, fixtures.callbackFailure]) {
      const signature = await sign(body.data.taskId, timestamp)
      const [req, raw] = webhook(body, {
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': signature,
      })
      expect(await provider.parseWebhook(req, raw)).toEqual({ jobId: body.data.taskId })
    }
  })

  it('签名错误、篡改 taskId、缺头、时间戳超窗或正文无效时返回 400', async () => {
    const { provider } = setup([])
    const body = fixtures.callbackSuccess
    const good = await sign(body.data.taskId, timestamp)
    const stale = String(Number(timestamp) - 301)
    const cases: [unknown, Record<string, string>][] = [
      [
        body,
        {
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': await sign(body.data.taskId, timestamp, 'wrong-key'),
        },
      ],
      [
        { ...body, data: { ...body.data, taskId: 'forged_task' } },
        { 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': good },
      ],
      [body, { 'X-Webhook-Timestamp': timestamp }],
      [body, { 'X-Webhook-Signature': good }],
      [
        body,
        {
          'X-Webhook-Timestamp': stale,
          'X-Webhook-Signature': await sign(body.data.taskId, stale),
        },
      ],
      [body, { 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': 'not-base64!' }],
      [{ code: 200 }, { 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': good }],
    ]
    for (const [payload, headers] of cases) {
      const [req, raw] = webhook(payload, headers)
      await expect(provider.parseWebhook(req, raw)).rejects.toMatchObject({
        code: 'MEDIA_WEBHOOK_INVALID',
        status: 400,
      })
    }
  })

  it('未配置验签密钥时拒绝回调', async () => {
    const provider = createKieMediaProvider({
      apiKey: 'k',
      webhookSecret: '',
      modelId,
      fetch: vi.fn<typeof globalThis.fetch>(),
      now: () => now,
    })
    const [req, raw] = webhook(fixtures.callbackSuccess, {})
    await expect(provider.parseWebhook(req, raw)).rejects.toMatchObject({
      code: 'AI_PROVIDER_NOT_CONFIGURED',
    })
  })
})

describe('kie.ai 错误分类与模型支持', () => {
  it('错误码映射到共用失败分类', () => {
    expect(kieFailureKind(401)).toBe('auth')
    expect(kieFailureKind(402)).toBe('auth')
    expect(kieFailureKind(429)).toBe('rate_limited')
    expect(kieFailureKind(433)).toBe('rate_limited')
    expect(kieFailureKind(455)).toBe('provider_error')
    expect(kieFailureKind(500)).toBe('provider_error')
    expect(kieFailureKind(501)).toBe('provider_error')
    expect(kieFailureKind(501, 'NSFW content detected')).toBe('content_policy')
    expect(kieFailureKind(505)).toBe('unavailable')
    expect(kieFailureKind(422)).toBe('rejected_input')
    expect(kieFailureKind(400, 'violates content policy')).toBe('content_policy')
    expect(kieFailureKind(undefined)).toBe('provider_error')
  })

  it('只走专用接口或结果结构不同的模型族不支持', () => {
    for (const id of [
      'seedream/4.5-text-to-image',
      'kling-4.0/reference-to-video',
      'runway',
      'z-image',
    ])
      expect(isKieUnifiedModel(id)).toBe(true)
    for (const id of [
      'veo-3-1',
      'veo/extend',
      '4o-image-api',
      'flux1-kontext',
      'suno-v5',
      '',
      '../x',
      'a b',
    ])
      expect(isKieUnifiedModel(id)).toBe(false)
  })

  it('注册表：两个密钥都配置才可用，不支持的模型抛 MODEL_UNAVAILABLE，白名单为精确主机', () => {
    const env = { KIE_API_KEY: 'fixture', KIE_WEBHOOK_SECRET: 'fixture' }
    expect(() => requireMediaProviderDefinition('kie', env, ['fal'])).toThrow('not enabled')
    expect(() =>
      requireMediaProviderDefinition('kie', { KIE_API_KEY: 'fixture' }, ['kie']),
    ).toThrow('not configured')
    const definition = requireMediaProviderDefinition('kie', env, ['kie'])
    expect(definition.create(env, { modelId }).capabilities.idempotentSubmit).toBe(false)
    expect(() => definition.create(env, { modelId: 'veo-3-1' })).toThrow(
      expect.objectContaining({ code: 'MODEL_UNAVAILABLE' }),
    )
    expect(getMediaOutputHosts('kie')).toEqual([...KIE_OUTPUT_HOSTS])
  })
})
