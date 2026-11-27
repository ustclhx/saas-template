import { env } from 'cloudflare:workers'
import {
  createFalMediaProvider,
  initialMediaFaultProof,
  MEDIA_HOLD_SWEEP_BUFFER_MS,
  type MediaFaultMode,
  type MediaProvider,
  type MediaWebhook,
  mediaCallbackUrl,
  mediaFaultPolicy,
  readMediaFault,
  settleMediaTask,
  updateMediaFaultProof,
  WORKERS_AI_IMAGE_MODEL,
} from '@saas/ai'
import { createAuth } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { getCreditBalance, grant, hold } from '@saas/credits'
import { aiModel, aiTask, createDb, creditHold, file, member as membership, scoped } from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { createCloudflareRateLimiter, createCloudflareWorkflow } from '@saas/platform/cloudflare'
import { AppError, newId } from '@saas/shared'
import { afterAll, describe, expect, it } from 'vitest'
import {
  handleMediaCancel,
  handleMediaCancelPreview,
  handleMediaDetail,
  handleMediaList,
  handleMediaSubmit,
  handleMediaWebhook,
  type MediaHttpDeps,
  submitWorkspaceMedia,
} from '../../../plugins/media/src/web/media-tasks.ts'
import { enabledStudioKinds } from '../../../plugins/studio/src/kinds.ts'
import type { submitStudio } from '../../../plugins/studio/src/web/submit.functions.ts'
import { submitStudioCreation } from '../../../plugins/studio/src/web/submit.server.ts'
import { templateConfig } from '../src/server/template-config.ts'
import { resolveDefaultWorkspace } from '../src/server/workspace-context.ts'

const APP_URL = 'http://localhost:3000'
const SECRET = 'fixture-media-webhook-secret'
const EMAIL_DOMAIN = `${newId()}.web-media-test.example`
const MODEL_PREFIX = `media-test-${newId()}-`
const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const auth = createAuth(
  { BETTER_AUTH_SECRET: 'fixture-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL },
  db,
  {
    config: defineTemplateConfig({
      app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
      auth: { oauth: [], turnstile: false },
    }),
    sendEmail: async () => {},
  },
)
const authPost = (path: string, body: unknown) =>
  auth.handler(
    new Request(`${APP_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_URL },
      body: JSON.stringify(body),
    }),
  )
async function account(name: string) {
  const email = `${name}-${newId()}@${EMAIL_DOMAIN}`
  const registered = await authPost('/sign-up/email', {
    email,
    password: 'correct-horse-battery-staple',
    name,
  })
  expect(registered.status).toBe(200)
  const { user } = (await registered.json()) as { user: { id: string } }
  const login = await authPost('/sign-in/email', {
    email,
    password: 'correct-horse-battery-staple',
  })
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  await grant(db, { workspaceId: user.id, source: 'admin', sourceRef: newId(), amount: 100 })
  return { userId: user.id, workspaceId: user.id, cookie }
}
const modelParamsSchema = {
  type: 'object',
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1 },
    num_images: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
  },
}

async function model(
  extra: Record<string, unknown> = {},
  provider = 'fal',
  kind: 'image' | 'video' = 'image',
  paramsSchema: Record<string, unknown> = {
    ...modelParamsSchema,
    properties: { ...modelParamsSchema.properties, ...extra },
  },
) {
  const key = `${MODEL_PREFIX}${newId()}`
  await db.insert(aiModel).values({
    key,
    kind,
    provider,
    providerModelId: provider === 'workers-ai' ? WORKERS_AI_IMAGE_MODEL : 'fal-ai/fixture',
    pricing: { mode: 'per_call', credits: 3 },
    paramsSchema,
  })
  return key
}
async function faultModel(mode: MediaFaultMode) {
  const key = `acceptance-fault-${MODEL_PREFIX}${newId()}`
  const workers = mode.startsWith('workers-')
  await db.insert(aiModel).values({
    key,
    kind: 'image',
    provider: workers ? 'workers-ai' : 'fal',
    providerModelId: workers ? WORKERS_AI_IMAGE_MODEL : 'fal-ai/flux/schnell',
    pricing: { mode: 'per_call', credits: 3 },
    paramsSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        image_size: { type: 'string', enum: ['square', 'landscape_4_3'] },
        num_images: { type: 'integer', minimum: 1, maximum: 2 },
      },
      'x-acceptance-fault': { mode },
    },
  })
  return key
}
async function administrator(name: string) {
  const who = await account(name)
  // 保留原登录 cookie，敏感入口必须从数据库读取刚更新的平台角色。
  await sql`update "user" set role='admin' where id=${who.userId}`
  return who
}
function faultDependencies() {
  const state = dependencies()
  state.deps.env = {
    ...state.deps.env,
    AI_FAULT_INJECTION: 'enabled',
    SENTRY_ENVIRONMENT: 'staging',
    AI: {
      run: async () => {
        throw new Error('web must not infer')
      },
    },
  }
  return state
}
async function signedFalCallbacks() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const requests: string[] = []
  const provider = createFalMediaProvider({
    apiKey: 'fixture-only',
    modelId: 'fal-ai/flux/schnell',
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      // 仅提供临时公钥，任何队列、图片下载或未知请求都不能访问外部网络。
      if (url !== 'https://rest.fal.ai/.well-known/jwks.json')
        throw new Error('Unexpected fal fixture request')
      return Response.json({ keys: [{ x: publicKey.x }] })
    },
  })
  const hex = (bytes: ArrayBuffer) =>
    Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
  return {
    provider,
    requests,
    async request(taskId: string, jobId: string) {
      const url = await mediaCallbackUrl(APP_URL, SECRET, { id: taskId, provider: 'fal' })
      const body = JSON.stringify({
        request_id: jobId,
        status: 'OK',
        payload: {
          images: [{ url: 'https://v3.fal.media/fixture.png', content_type: 'image/png' }],
        },
      })
      const timestamp = String(Math.floor(Date.now() / 1000))
      const encoder = new TextEncoder()
      const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(body)))
      const signature = await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        encoder.encode([jobId, 'fixture-user', timestamp, hash].join('\n')),
      )
      return new Request(url, {
        method: 'POST',
        body,
        headers: {
          'x-fal-webhook-request-id': jobId,
          'x-fal-webhook-user-id': 'fixture-user',
          'x-fal-webhook-timestamp': timestamp,
          'x-fal-webhook-signature': hex(signature),
        },
      })
    },
  }
}
function dependencies(
  options: {
    max?: number
    startFails?: boolean
    cancelFails?: boolean
    // 取消读到 running 后实例自行结束：CF 绑定的 terminate 对终态实例抛错
    finishesBeforeTerminate?: boolean
    callback?: MediaWebhook
    invalidProviderSignature?: boolean
    /** 服务商作业状态；'error' 表示状态查询失败。 */
    providerStatus?: 'queued' | 'running' | 'error'
  } = {},
) {
  let parsed = 0
  let canceled = 0
  let terminated = 0
  let events = 0
  let statusChecks = 0
  const provider: MediaProvider = {
    id: 'fal',
    capabilities: { idempotentSubmit: false },
    submit: async () => ({ jobId: 'unused' }),
    getStatus: async () => {
      statusChecks++
      if (options.providerStatus === 'error') throw new Error('fixture status unavailable')
      return { status: options.providerStatus ?? 'queued' }
    },
    parseWebhook: async () => {
      parsed++
      if (options.invalidProviderSignature)
        throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid provider signature')
      return (
        options.callback ?? {
          jobId: 'fixture-job',
          result: { outputs: [{ url: 'https://v3.fal.media/output.png', mime: 'image/png' }] },
        }
      )
    },
    cancel: async () => {
      canceled++
      if (options.cancelFails) throw new Error('fixture cancel unavailable')
    },
  }
  const deps: MediaHttpDeps = {
    db,
    auth,
    env: { MEDIA_WEBHOOK_SECRET: SECRET },
    rateLimiter: createCloudflareRateLimiter({ RL_AI: { limit: async () => ({ success: true }) } }),
    providerFactory: () => provider,
    entitlements: async () => ({
      key: 'fixture',
      sort: 0,
      features: { ...DEFAULT_FREE_FEATURES, models: ['*'], maxConcurrentTasks: options.max ?? 3 },
    }),
    workflow: {
      available: true,
      value: createCloudflareWorkflow({
        create: async () => {
          if (options.startFails) throw new Error('fixture start unavailable')
          return {
            id: 'fixture-created',
            status: async () => ({ status: 'running' }),
            terminate: async () => {},
            sendEvent: async () => {},
          }
        },
        get: async (instanceId: string) => {
          let finished = false
          return {
            id: instanceId,
            status: async () => ({
              status: finished ? 'complete' : terminated > 0 ? 'terminated' : 'running',
            }),
            terminate: async () => {
              if (options.finishesBeforeTerminate) {
                finished = true
                throw new Error(
                  'WorkflowError: (instance.cannot_terminate) Cannot terminate instance since its on a finite state',
                )
              }
              terminated++
            },
            sendEvent: async () => {
              events++
              const [stored] =
                await sql`select callback_payload from ai_task where workflow_instance_id=${instanceId}`
              expect(stored?.callback_payload).not.toBeNull()
              throw new Error('fixture delivery unavailable')
            },
          }
        },
      } as unknown as Parameters<typeof createCloudflareWorkflow>[0]),
    },
  }
  return { deps, counts: () => ({ parsed, canceled, terminated, events, statusChecks }) }
}
function post(path: string, who: { cookie: string }, body: unknown) {
  return new Request(`${APP_URL}${path}`, {
    method: 'POST',
    headers: { cookie: who.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function submit(
  who: { workspaceId: string; cookie: string },
  key: string,
  deps: MediaHttpDeps,
  params: Record<string, unknown> = { prompt: 'fixture' },
) {
  return handleMediaSubmit(
    post('/api/ai/tasks', who, { workspaceId: who.workspaceId, modelKey: key, params }),
    deps,
  )
}
async function submitted(
  who: { workspaceId: string; cookie: string },
  key: string,
  deps: MediaHttpDeps,
) {
  const res = await submit(who, key, deps)
  expect(res.status).toBe(202)
  return ((await res.json()) as { taskId: string }).taskId
}

afterAll(async () => {
  if (!templateConfig.plugins.media) return
  const ids = sql`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  await sql`delete from file where workspace_id in (${ids})`
  await sql`delete from notification where workspace_id in (${ids})`
  await sql`delete from ai_task where workspace_id in (${ids})`
  await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id in (${ids}))`
  await sql`delete from credit_ledger where workspace_id in (${ids})`
  await sql`delete from credit_hold where workspace_id in (${ids})`
  await sql`delete from credit_grant where workspace_id in (${ids})`
  await sql`delete from credit_debt where workspace_id in (${ids})`
  await sql`delete from session where user_id in (${ids})`
  await sql`delete from account where user_id in (${ids})`
  await sql`delete from member where organization_id in (${ids}) or user_id in (${ids})`
  await sql`delete from organization where id in (${ids})`
  await sql`delete from "user" where id in (${ids})`
  await sql`delete from ai_model where key like ${`${MODEL_PREFIX}%`}`
  await sql`delete from ai_model where key like ${`acceptance-fault-${MODEL_PREFIX}%`}`
})

describe.skipIf(!templateConfig.plugins.media)('media tasks API', () => {
  it.each(['workers-timeout', 'fal-timeout'] as const)(
    '%s 冻结管理员故障策略和 60 秒 deadline，模型停用与并发证明更新不改变输入',
    async (mode) => {
      const who = await administrator(mode)
      const key = await faultModel(mode)
      const { deps } = faultDependencies()
      const before = Date.now()
      const taskId = await submitted(who, key, deps)
      const acceptedAt = Date.now()
      const tenant = scoped(db, who.workspaceId)
      const task = await tenant.findById(aiTask, taskId)
      const snapshot = mediaFaultPolicy(mode)
      expect(task.input.acceptanceFault).toEqual(snapshot)
      expect(snapshot).toMatchObject({
        policyVersion: 1,
        authorizedAdmin: true,
        deadlineMs: 60_000,
        initialWaitMs: mode === 'fal-timeout' ? 5_000 : 0,
        barrierMs: 0,
      })
      expect(task.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + 60_000)
      expect(task.deadlineAt.getTime()).toBeLessThanOrEqual(acceptedAt + 60_000)
      const [reservation] = await sql<{ expires_at: string }[]>`
        select expires_at from credit_hold where id=${task.holdId}`
      expect(new Date(reservation?.expires_at ?? '').getTime()).toBe(
        task.deadlineAt.getTime() + 10 * 60_000,
      )
      expect(task.input.acceptanceFaultProof).toEqual(initialMediaFaultProof(snapshot))
      if (mode === 'fal-timeout')
        expect(task.input.params).toEqual({
          prompt: 'fixture',
          image_size: 'square',
          num_images: 1,
        })

      const changedMode = mode === 'workers-timeout' ? 'workers-error' : 'fal-provider-error'
      await sql`update ai_model set enabled=false, params_schema=jsonb_set(params_schema,
        '{x-acceptance-fault}', ${JSON.stringify({ mode: changedMode })}::jsonb) where key=${key}`
      expect(readMediaFault(await tenant.findById(aiTask, taskId))).toEqual(snapshot)
      expect((await submit(who, key, deps)).status).toBe(404)
      await Promise.all([
        updateMediaFaultProof(db, task, { submitAttempts: 1, realRequestId: 'fixture-proof-job' }),
        updateMediaFaultProof(db, task, { pollCount: 2, injected: true }),
      ])
      const updated = await tenant.findById(aiTask, taskId)
      expect(updated.input).toEqual({
        ...task.input,
        acceptanceFaultProof: {
          ...initialMediaFaultProof(snapshot),
          submitAttempts: 1,
          realRequestId: 'fixture-proof-job',
          pollCount: 2,
          injected: true,
        },
      })
      expect(updated.deadlineAt).toEqual(task.deadlineAt)
      expect(await tenant.count(aiTask)).toBe(1)
      expect(
        await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
      ).toHaveLength(1)
    },
  )

  it('fal 专用请求拒绝非 square 或多图片且不预扣，合法请求固定为单张 square', async () => {
    const who = await administrator('fault-params')
    const key = await faultModel('fal-callback-lost')
    const { deps } = faultDependencies()
    for (const params of [
      { prompt: 'fixture', image_size: 'landscape_4_3' },
      { prompt: 'fixture', num_images: 2 },
    ]) {
      const response = await submit(who, key, deps, params)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
    }
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(
      await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
    ).toHaveLength(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    const taskId = await submitted(who, key, deps)
    const task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task.input.params).toEqual({ prompt: 'fixture', image_size: 'square', num_images: 1 })
    expect(task.input.unitsLimit).toBe(1)
    expect(task.input.acceptanceFault).toEqual(mediaFaultPolicy('fal-callback-lost'))
  })

  it('early 回调经过真实 HMAC 和 fal Ed25519 验签先落库，重放保留首次时间及不可变输入', async () => {
    const who = await administrator('fault-early-callback')
    const state = faultDependencies()
    const signed = await signedFalCallbacks()
    state.deps.providerFactory = () => signed.provider
    const taskId = await submitted(who, await faultModel('fal-callback-early'), state.deps)
    const tenant = scoped(db, who.workspaceId)
    const original = await tenant.findById(aiTask, taskId)
    expect(original.input.acceptanceFault).toEqual({
      mode: 'fal-callback-early',
      policyVersion: 1,
      authorizedAdmin: true,
      deadlineMs: 20 * 60_000,
      initialWaitMs: 5_000,
      barrierMs: 10 * 60_000,
    })
    expect(original.providerJobId).toBeNull()
    expect(
      (
        await handleMediaWebhook(
          await signed.request(taskId, 'fixture-early-job'),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    const stored = await tenant.findById(aiTask, taskId)
    const proof = stored.input.acceptanceFaultProof as { callbackStoredAt: string }
    expect(Number.isFinite(Date.parse(proof.callbackStoredAt))).toBe(true)
    expect(stored.input).toEqual({
      ...original.input,
      acceptanceFaultProof: {
        ...(original.input.acceptanceFaultProof as object),
        callbackStoredAt: proof.callbackStoredAt,
      },
    })
    expect(stored.callbackPayload).toMatchObject({
      jobId: 'fixture-early-job',
      result: { outputs: [{ url: 'https://v3.fal.media/fixture.png', mime: 'image/png' }] },
    })
    expect(state.counts().events).toBe(1)
    expect(
      (
        await handleMediaWebhook(
          await signed.request(taskId, 'fixture-early-job'),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    const replayed = await tenant.findById(aiTask, taskId)
    expect(replayed.input).toEqual(stored.input)
    expect(replayed.callbackPayload).toEqual(stored.callbackPayload)
    expect(replayed.status).toBe('queued')
    expect(replayed.output).toBeNull()
    expect(signed.requests).toEqual(['https://rest.fal.ai/.well-known/jwks.json'])
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })
  })

  it.each([
    'fal-callback-lost',
    'fal-submit-response-lost',
    'fal-provider-error',
    'fal-timeout',
  ] as const)('%s 只在真实签名校验后忽略成功回调，终态重放不产出或重复结算', async (mode) => {
    const who = await administrator(mode)
    const state = faultDependencies()
    const signed = await signedFalCallbacks()
    state.deps.providerFactory = () => signed.provider
    const taskId = await submitted(who, await faultModel(mode), state.deps)
    const tenant = scoped(db, who.workspaceId)
    const original = await tenant.findById(aiTask, taskId)
    const invalid = await signed.request(taskId, 'fixture-ignored-job')
    invalid.headers.set('x-fal-webhook-signature', '0'.repeat(128))
    expect((await handleMediaWebhook(invalid, 'fal', state.deps)).status).toBe(400)
    expect(
      (
        await handleMediaWebhook(
          await signed.request(taskId, 'fixture-ignored-job'),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    const ignored = await tenant.findById(aiTask, taskId)
    expect(ignored.input).toEqual(original.input)
    expect(ignored.callbackPayload).toBeNull()
    expect(ignored.status).toBe('queued')
    expect(ignored.output).toBeNull()
    expect(state.counts().events).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })

    if (mode !== 'fal-callback-lost') {
      await settleMediaTask(db, {
        workspaceId: who.workspaceId,
        taskId,
        outcome: 'failed',
        error: { code: 'FIXTURE_FAULT', message: 'Fixture failure' },
      })
      const failed = await tenant.findById(aiTask, taskId)
      const ledger =
        await sql`select id, delta, type from credit_ledger where workspace_id=${who.workspaceId}`
      expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(0)
      const holds =
        await sql`select id, status, captured_amount from credit_hold where workspace_id=${who.workspaceId}`
      const notifications =
        await sql`select id from notification where workspace_id=${who.workspaceId}`
      expect(notifications).toHaveLength(1)
      expect(holds).toEqual([{ id: failed.holdId, status: 'released', captured_amount: 0 }])
      for (let repeat = 0; repeat < 2; repeat++)
        expect(
          (
            await handleMediaWebhook(
              await signed.request(taskId, 'fixture-ignored-job'),
              'fal',
              state.deps,
            )
          ).status,
        ).toBe(200)
      expect(await tenant.findById(aiTask, taskId)).toEqual(failed)
      expect(
        await sql`select id, delta, type from credit_ledger where workspace_id=${who.workspaceId}`,
      ).toEqual(ledger)
      expect(
        await sql`select id, status, captured_amount from credit_hold where workspace_id=${who.workspaceId}`,
      ).toEqual(holds)
      expect(await sql`select id from notification where workspace_id=${who.workspaceId}`).toEqual(
        notifications,
      )
      expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    }
    expect(await tenant.count(file)).toBe(0)
    expect(
      await sql`select id from notification where workspace_id=${who.workspaceId}`,
    ).toHaveLength(mode === 'fal-callback-lost' ? 0 : 1)
    expect(signed.requests).toEqual(['https://rest.fal.ai/.well-known/jwks.json'])
  })

  it('故障媒体对普通空间 owner 和没有 fresh session 的管理员调用均拒绝，且不创建任务或预扣', async () => {
    const who = await account('fault-denied')
    const key = `acceptance-fault-${newId()}`
    await db.insert(aiModel).values({
      key,
      kind: 'image',
      provider: 'fal',
      providerModelId: 'fal-ai/flux/schnell',
      pricing: { mode: 'per_call', credits: 1 },
      paramsSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        'x-acceptance-fault': { mode: 'fal-timeout' },
      },
    })
    try {
      const { deps } = dependencies()
      deps.env.AI_FAULT_INJECTION = 'enabled'
      deps.env.SENTRY_ENVIRONMENT = 'staging'
      expect((await submit(who, key, deps)).status).toBe(404)
      await sql`update member set role='admin' where user_id=${who.userId}`
      expect((await submit(who, key, deps)).status).toBe(404)
      await sql`update "user" set role='admin' where id=${who.userId}`
      const workspace = await db.query.organization.findFirst({
        where: (o, { eq }) => eq(o.id, who.workspaceId),
      })
      const member = await db.query.member.findFirst({
        where: (m, { eq }) => eq(m.userId, who.userId),
      })
      if (!workspace || !member) throw new Error('Missing fixture workspace')
      await expect(
        submitWorkspaceMedia(
          { modelKey: key, params: { prompt: 'fixture' } },
          { workspace, member },
          { ...deps, callbackOrigin: APP_URL },
        ),
      ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
      expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
      expect(await sql`select id from credit_hold where workspace_id=${who.workspaceId}`).toEqual(
        [],
      )
      expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    } finally {
      await sql`delete from ai_model where key=${key}`
    }
  })

  it('media insufficient credits preserves the shared numeric 402 contract', async () => {
    const who = await account('insufficient-credits')
    await hold(db, {
      workspaceId: who.workspaceId,
      userId: who.userId,
      amount: 98,
      refType: 'ai_message',
      refId: newId(),
    })
    const { deps } = dependencies()
    const response = await submit(who, await model(), deps)
    expect(response.status).toBe(402)
    expect(await response.json()).toEqual({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits',
        details: { estimatedCredits: 3, availableCredits: 2 },
      },
    })
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 2, held: 98 })
  })

  it('rejects an unavailable workflow before rate limiting, task creation or credit holds', async () => {
    const who = await account('workflow-unavailable')
    const { deps } = dependencies()
    deps.workflow = { available: false }
    let calls = 0
    deps.rateLimiter = {
      limit: async () => {
        calls++
        return { success: true }
      },
    }
    const response = await submit(who, await model(), deps)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'CAPABILITY_UNAVAILABLE' } })
    expect(calls).toBe(0)
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(
      await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
    ).toHaveLength(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('rejects unknown, disabled and unconfigured providers before task creation or credit hold', async () => {
    const who = await account('provider-unavailable')
    const { deps } = dependencies()
    expect((await submit(who, await model({}, 'unknown'), deps)).status).toBe(404)
    expect((await submit(who, await model({}, 'workers-ai', 'video'), deps)).status).toBe(404)
    const media = templateConfig.plugins.media
    if (!media) throw new Error('The media plugin must be enabled')
    const enabled = media.providers
    try {
      Object.defineProperty(media, 'providers', {
        value: ['fal'],
        configurable: true,
      })
      expect((await submit(who, await model({}, 'workers-ai'), deps)).status).toBe(404)
    } finally {
      Object.defineProperty(media, 'providers', {
        value: enabled,
        configurable: true,
      })
    }
    const { providerFactory: _factory, ...realDeps } = deps
    for (const provider of ['fal', 'workers-ai'])
      expect((await submit(who, await model({}, provider), realDeps)).status).toBe(503)
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(
      await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
    ).toHaveLength(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('accepts a configured Workers AI model without callback secret or invoking inference in web', async () => {
    const who = await account('workers-ai')
    const { deps } = dependencies()
    const { providerFactory: _factory, ...realDeps } = deps
    let calls = 0
    realDeps.env = {
      AI: {
        run: async () => {
          calls++
          throw new Error('web must not infer')
        },
      },
    }
    const taskId = await submitted(who, await model({}, 'workers-ai'), realDeps)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).provider).toBe('workers-ai')
    expect(calls).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })
  })

  it('returns 404 for unknown and synchronous provider callbacks before signature or database lookup', async () => {
    const { deps } = dependencies()
    deps.env = {}
    for (const provider of ['unknown', 'workers-ai'])
      expect(
        (
          await handleMediaWebhook(
            new Request(`${APP_URL}/api/webhooks/media/${provider}`),
            provider,
            deps,
          )
        ).status,
      ).toBe(404)
  })

  it('serializes genuinely concurrent submissions under the workspace limit with only accepted holds', async () => {
    const who = await account('concurrency')
    const key = await model()
    const { deps } = dependencies({ max: 2 })
    const results = await Promise.all([
      submit(who, key, deps),
      submit(who, key, deps),
      submit(who, key, deps),
    ])
    expect(results.map((res) => res.status).sort()).toEqual([202, 202, 403])
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(2)
    const [task] = await scoped(db, who.workspaceId).select(aiTask)
    expect(task?.input.callbackOrigin).toBe(APP_URL)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 94, held: 6 })
    const reservations = await sql<{ expires_at: string; deadline_at: string }[]>`
      select h.expires_at, t.deadline_at from credit_hold h
      join ai_task t on t.hold_id=h.id
      where h.workspace_id=${who.workspaceId} and h.status='held'`
    expect(reservations).toHaveLength(2)
    for (const reservation of reservations)
      expect(new Date(reservation.expires_at).getTime()).toBe(
        new Date(reservation.deadline_at).getTime() + MEDIA_HOLD_SWEEP_BUFFER_MS,
      )
  })

  it('rejects invalid parameters and pending file references before reserving credits', async () => {
    const who = await account('invalid')
    const key = await model({ source: { type: 'string', format: 'file' } })
    const { deps } = dependencies()
    expect((await submit(who, key, deps, { prompt: 'fixture', num_images: 10 })).status).toBe(400)
    const fileId = newId()
    await scoped(db, who.workspaceId).insert(file, {
      id: fileId,
      userId: who.userId,
      purpose: 'upload',
      status: 'pending',
      r2Key: `ws/${who.workspaceId}/${fileId}`,
      mime: 'image/png',
      size: 100,
    })
    expect((await submit(who, key, deps, { prompt: 'fixture', source: fileId })).status).toBe(400)
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('releases the reservation when Workflow creation fails', async () => {
    const who = await account('start-failure')
    const { deps } = dependencies({ startFails: true })
    expect((await submit(who, await model(), deps)).status).toBe(503)
    const [task] = await scoped(db, who.workspaceId).select(aiTask)
    expect(task?.status).toBe('failed')
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('persists an early verified callback before sending an event, deduplicates it, and returns 200 on event failure', async () => {
    const who = await account('callback')
    const state = dependencies()
    const taskId = await submitted(who, await model(), state.deps)
    const url = await mediaCallbackUrl(APP_URL, SECRET, { id: taskId, provider: 'fal' })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    expect(state.counts()).toMatchObject({ parsed: 1, events: 1 })
    const first = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(first.callbackPayload?.jobId).toBe('fixture-job')
    const duplicate = dependencies({
      callback: { jobId: 'fixture-job', error: { code: 'later-error', message: 'later' } },
    })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          duplicate.deps,
        )
      ).status,
    ).toBe(200)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).callbackPayload).toEqual(
      first.callbackPayload,
    )
    const bad = new URL(url)
    bad.searchParams.set('sig', '0'.repeat(64))
    expect((await handleMediaWebhook(new Request(bad), 'fal', state.deps)).status).toBe(400)
    expect(state.counts().parsed).toBe(1)
    const invalidSignature = dependencies({ invalidProviderSignature: true })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          invalidSignature.deps,
        )
      ).status,
    ).toBe(400)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, { providerJobId: 'different-job' })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(400)
  })

  it('allows only the submitter to cancel, refunds queued tasks once, and keeps query DTOs private', async () => {
    const owner = await account('cancel')
    const other = await account('member')
    await scoped(db, owner.workspaceId).insert(membership, {
      id: newId(),
      userId: other.userId,
      role: 'member',
    })
    const state = dependencies()
    const taskId = await submitted(owner, await model(), state.deps)
    expect(
      (
        await handleMediaCancel(
          post(`/api/ai/tasks/${taskId}/cancel`, other, { workspaceId: owner.workspaceId }),
          taskId,
          state.deps,
        )
      ).status,
    ).toBe(404)
    const detail = await handleMediaDetail(
      new Request(`${APP_URL}/api/ai/tasks/${taskId}?workspaceId=${owner.workspaceId}`, {
        headers: { cookie: other.cookie },
      }),
      taskId,
      state.deps,
    )
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { task: Record<string, unknown> }
    expect(body.task.canCancel).toBe(false)
    for (const hidden of ['providerJobId', 'callbackPayload', 'providerRequestKey', 'holdId'])
      expect(body.task).not.toHaveProperty(hidden)
    for (let repeat = 0; repeat < 2; repeat++)
      expect(
        (
          await handleMediaCancel(
            post(`/api/ai/tasks/${taskId}/cancel`, owner, { workspaceId: owner.workspaceId }),
            taskId,
            state.deps,
          )
        ).status,
      ).toBe(200)
    expect((await scoped(db, owner.workspaceId).findById(aiTask, taskId)).status).toBe('canceled')
    expect(await getCreditBalance(db, owner.workspaceId)).toMatchObject({ available: 100, held: 0 })
    expect(state.counts().terminated).toBe(1)
    const list = await handleMediaList(
      new Request(`${APP_URL}/api/ai/tasks?workspaceId=${owner.workspaceId}`, {
        headers: { cookie: owner.cookie },
      }),
      state.deps,
    )
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1)
  })

  it('persists recoverable cancellation failure after refund and retries external work without repeating settlement', async () => {
    const who = await account('cancel-retry')
    const options = { cancelFails: true }
    const state = dependencies(options)
    const taskId = await submitted(who, await model(), state.deps)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, {
      providerJobId: 'fixture-job',
      status: 'running',
    })
    const cancel = () =>
      handleMediaCancel(
        post(`/api/ai/tasks/${taskId}/cancel`, who, { workspaceId: who.workspaceId }),
        taskId,
        state.deps,
      )
    expect((await cancel()).status).toBe(202)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBe(
      'MEDIA_CANCEL_PENDING',
    )
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    options.cancelFails = false
    expect((await cancel()).status).toBe(200)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBeNull()
    expect(state.counts()).toMatchObject({ canceled: 2, terminated: 1 })
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('does not leave a retry marker when the workflow finishes on its own between status and terminate', async () => {
    const who = await account('cancel-race')
    const state = dependencies({ finishesBeforeTerminate: true })
    const taskId = await submitted(who, await model(), state.deps)
    const response = await handleMediaCancel(
      post(`/api/ai/tasks/${taskId}/cancel`, who, { workspaceId: who.workspaceId }),
      taskId,
      state.deps,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'canceled', cancellationPending: false })
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBeNull()
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('retains the cancellation retry marker while an accepted submission has not returned its job ID', async () => {
    const who = await account('cancel-submit')
    const state = dependencies()
    const taskId = await submitted(who, await model(), state.deps)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, {
      output: { submissionAttempted: true },
    })
    const response = await handleMediaCancel(
      post(`/api/ai/tasks/${taskId}/cancel`, who, { workspaceId: who.workspaceId }),
      taskId,
      state.deps,
    )
    expect(response.status).toBe(202)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBe(
      'MEDIA_CANCEL_PENDING',
    )
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })
})

describe.skipIf(!templateConfig.plugins.media)('媒体取消计费、不确定提交回调与存储配额', () => {
  const cancelUrl = (who: { workspaceId: string }, taskId: string) =>
    `${APP_URL}/api/ai/tasks/${taskId}/cancel?workspaceId=${who.workspaceId}`
  async function preview(
    who: { workspaceId: string; cookie: string },
    taskId: string,
    deps: MediaHttpDeps,
  ) {
    const response = await handleMediaCancelPreview(
      new Request(cancelUrl(who, taskId), { headers: { cookie: who.cookie } }),
      taskId,
      deps,
    )
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }
  async function cancel(
    who: { workspaceId: string; cookie: string },
    taskId: string,
    deps: MediaHttpDeps,
  ) {
    const response = await handleMediaCancel(
      post(`/api/ai/tasks/${taskId}/cancel`, who, { workspaceId: who.workspaceId }),
      taskId,
      deps,
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  // 模拟 Workflow 已提交：服务商已受理并返回作业 ID。
  async function accepted(who: { workspaceId: string; cookie: string }, deps: MediaHttpDeps) {
    const taskId = await submitted(who, await model(), deps)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, {
      providerJobId: `job-${taskId}`,
      status: 'running',
    })
    return taskId
  }

  it('排队中的任务取消免费且不占用免费次数', async () => {
    const who = await account('cancel-queued')
    const state = dependencies({ providerStatus: 'queued' })
    const taskId = await accepted(who, state.deps)
    expect(await preview(who, taskId, state.deps)).toMatchObject({
      cancelable: true,
      started: false,
      charged: false,
      credits: 0,
      freeStartedRemaining: 1,
    })
    expect(await cancel(who, taskId, state.deps)).toMatchObject({
      status: 200,
      body: { status: 'canceled', cancelBilling: 'free_unstarted', creditsCharged: 0 },
    })
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    const next = await accepted(who, dependencies({ providerStatus: 'running' }).deps)
    expect(
      await preview(who, next, dependencies({ providerStatus: 'running' }).deps),
    ).toMatchObject({ started: true, charged: false, freeStartedRemaining: 1 })
  })

  it('异步任务 Workflow 运行中但尚未尝试提交：取消免费且不占用已开始免费次数', async () => {
    const who = await account('cancel-running-unsubmitted')
    const state = dependencies({ providerStatus: 'running' })
    const taskId = await submitted(who, await model(), state.deps)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, { status: 'running' })
    expect(await preview(who, taskId, state.deps)).toMatchObject({
      started: false,
      charged: false,
      freeStartedRemaining: 1,
    })
    expect((await cancel(who, taskId, state.deps)).body).toMatchObject({
      status: 'canceled',
      cancelBilling: 'free_unstarted',
      creditsCharged: 0,
    })
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    expect(state.counts().statusChecks).toBe(0)
    const next = await accepted(who, state.deps)
    expect(await preview(who, next, state.deps)).toMatchObject({
      started: true,
      charged: false,
      freeStartedRemaining: 1,
    })
  })

  it('已开始生成：首次免费取消全额退回，第二次按定价快照全价扣费，重复取消不重复结算', async () => {
    const who = await account('cancel-started')
    const state = dependencies({ providerStatus: 'running' })
    const first = await accepted(who, state.deps)
    expect(await preview(who, first, state.deps)).toMatchObject({
      started: true,
      charged: false,
      credits: 0,
      freeStartedRemaining: 1,
    })
    expect((await cancel(who, first, state.deps)).body).toMatchObject({
      status: 'canceled',
      cancelBilling: 'free_started',
      creditsCharged: 0,
    })
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    expect(state.counts().canceled).toBe(1)

    const second = await accepted(who, state.deps)
    expect(await preview(who, second, state.deps)).toMatchObject({
      started: true,
      charged: true,
      credits: 3,
      freeStartedRemaining: 0,
    })
    for (let repeat = 0; repeat < 2; repeat++)
      expect((await cancel(who, second, state.deps)).body).toMatchObject({
        status: 'canceled',
        cancelBilling: 'charged',
        creditsCharged: 3,
      })
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 0 })
    const [consumed] = await sql<{ total: number }[]>`
      select coalesce(sum(delta),0)::integer as total from credit_ledger
      where workspace_id=${who.workspaceId} and type='consume'`
    expect(consumed?.total).toBe(-3)
    expect(await preview(who, second, state.deps)).toMatchObject({
      cancelable: false,
      freeStartedRemaining: 0,
    })
  })

  it('状态查询失败按已开始处理，并发取消只使用一次免费次数', async () => {
    const who = await account('cancel-status-error')
    const state = dependencies({ providerStatus: 'error' })
    const [a, b] = [await accepted(who, state.deps), await accepted(who, state.deps)]
    expect(await preview(who, a, state.deps)).toMatchObject({ started: true, charged: false })
    const results = await Promise.all([cancel(who, a, state.deps), cancel(who, b, state.deps)])
    expect(results.map((result) => result.body.cancelBilling).sort()).toEqual([
      'charged',
      'free_started',
    ])
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 0 })
    expect(state.counts().statusChecks).toBeGreaterThanOrEqual(3)
  })

  it('数据库层保证每个工作区终身只有一次已开始免费取消', async () => {
    const who = await account('cancel-unique')
    const state = dependencies()
    const [a, b] = [
      await submitted(who, await model(), state.deps),
      await submitted(who, await model(), state.deps),
    ]
    await scoped(db, who.workspaceId).updateById(aiTask, a, { cancelBilling: 'free_started' })
    await expect(
      scoped(db, who.workspaceId).updateById(aiTask, b, { cancelBilling: 'free_started' }),
    ).rejects.toThrow()
  })

  it('不确定提交的任务接受已验签回调并写入作业 ID；终态后的晚到回调只记日志', async () => {
    const who = await account('uncertain-callback')
    const state = dependencies({
      callback: {
        jobId: 'job-from-callback',
        result: { outputs: [{ url: 'https://v3.fal.media/output.png', mime: 'image/png' }] },
      },
    })
    const taskId = await submitted(who, await model(), state.deps)
    const tenant = scoped(db, who.workspaceId)
    await tenant.updateById(aiTask, taskId, {
      status: 'running',
      errorCode: 'MEDIA_SUBMISSION_UNCERTAIN',
      output: { submissionAttempted: true },
    })
    const url = await mediaCallbackUrl(APP_URL, SECRET, { id: taskId, provider: 'fal' })
    const callback = () =>
      handleMediaWebhook(new Request(url, { method: 'POST', body: '{}' }), 'fal', state.deps)
    expect((await callback()).status).toBe(200)
    expect(await tenant.findById(aiTask, taskId)).toMatchObject({
      status: 'running',
      providerJobId: 'job-from-callback',
      errorCode: null,
      callbackPayload: { jobId: 'job-from-callback' },
    })
    expect(state.counts().events).toBe(1)

    const late = await submitted(who, await model(), state.deps)
    await settleMediaTask(db, {
      workspaceId: who.workspaceId,
      taskId: late,
      outcome: 'failed',
      error: { code: 'MEDIA_SUBMISSION_UNCERTAIN', message: 'timed out' },
    })
    const lateUrl = await mediaCallbackUrl(APP_URL, SECRET, { id: late, provider: 'fal' })
    expect(
      (
        await handleMediaWebhook(
          new Request(lateUrl, { method: 'POST', body: '{}' }),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    expect(await tenant.findById(aiTask, late)).toMatchObject({
      status: 'failed',
      providerJobId: null,
      callbackPayload: null,
      creditsCharged: 0,
    })
    expect(state.counts().events).toBe(1)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })
  })

  it('存储用量已达配额时在预扣前拒绝提交，不创建任务', async () => {
    const who = await account('storage-full')
    const state = dependencies()
    state.deps.entitlements = async () => ({
      key: 'fixture',
      sort: 0,
      features: { ...DEFAULT_FREE_FEATURES, models: ['*'], maxConcurrentTasks: 3, storageGb: 0 },
    })
    const response = await submit(who, await model(), state.deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'STORAGE_QUOTA_EXCEEDED' } })
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })
})

type StudioSubmitData = Parameters<typeof submitStudio>[0]['data']

const studioModes = enabledStudioKinds(templateConfig)
const studioMode = studioModes[0] ?? 'image'

describe.skipIf(!templateConfig.plugins.media || studioModes.length === 0)('Studio 提交', () => {
  async function studioSubmission(
    who: Awaited<ReturnType<typeof account>>,
    modelKey: string,
    mode = studioMode,
  ) {
    const resolved = await resolveDefaultWorkspace(db, { id: who.userId }, who.workspaceId)
    if (!resolved) throw new Error('Studio test workspace is unavailable')
    const { deps } = dependencies()
    const data: StudioSubmitData = {
      slug: resolved.workspace.slug,
      mode,
      modelKey,
      prompt: '山间小屋',
      params: {},
    }
    const workspace = { ...resolved, workspaceReadOnly: false }
    const options = {
      config: templateConfig,
      presets: [],
      mediaDeps: () => ({
        ...deps,
        callbackOrigin: APP_URL,
      }),
    }
    return { data, workspace, options }
  }

  async function expectNoMediaReservation(workspaceId: string) {
    expect(await scoped(db, workspaceId).count(aiTask)).toBe(0)
    expect(
      await sql`select id from credit_hold where workspace_id=${workspaceId} and ref_type='ai_task'`,
    ).toHaveLength(0)
  }

  it('创建媒体任务并预扣积分，保留不含预设的原始提示词', async () => {
    const who = await account('studio-submit')
    const modelKey = await model({}, 'fal', studioMode)
    const { data, workspace, options } = await studioSubmission(who, modelKey)
    const prompt = '  山间小屋  '
    const preset = { id: 'watercolor', name: '水彩', mode: studioMode, text: '水彩画风' }
    const { taskId, status } = await submitStudioCreation(
      { ...data, prompt, presetId: preset.id },
      workspace,
      { ...options, presets: [preset] },
    )
    expect(status).toBe('queued')
    const tenant = scoped(db, who.workspaceId)
    const task = await tenant.findById(aiTask, taskId)
    expect(task).toMatchObject({
      modelKey,
      kind: studioMode,
      status: 'queued',
      input: { params: { prompt: `${prompt}\n${preset.text}` }, userPrompt: prompt },
    })
    expect(await tenant.select(creditHold)).toMatchObject([
      { id: task.holdId, refType: 'ai_task', refId: taskId, status: 'held', amount: 3 },
    ])
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })
  })

  it('未启用的模式返回 404', async () => {
    const who = await account('studio-disabled-mode')
    const { data, workspace, options } = await studioSubmission(
      who,
      await model({}, 'fal', studioMode),
    )
    const disabledMode = studioMode === 'image' ? 'video' : 'image'
    const config = {
      ...templateConfig,
      plugins: { ...templateConfig.plugins, studio: { kinds: [studioMode] } },
    }
    await expect(
      submitStudioCreation({ ...data, mode: disabledMode }, workspace, { ...options, config }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    await expectNoMediaReservation(who.workspaceId)
  })

  it('拒绝有效 schema 中缺少提示词字段的模型', async () => {
    const who = await account('studio-no-prompt-model')
    const modelKey = await model({}, 'fal', studioMode, {
      type: 'object',
      properties: { seed: { type: 'integer' } },
    })
    const { data, workspace, options } = await studioSubmission(who, modelKey)
    await expect(submitStudioCreation(data, workspace, options)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      status: 404,
    })
    await expectNoMediaReservation(who.workspaceId)
  })

  it('指出缺少参考图的字段，并拒绝其他空间或非图片文件', async () => {
    const who = await account('studio-reference')
    const mode = studioModes.includes('video') ? 'video' : studioMode
    const modelKey = await model({}, 'fal', mode, {
      ...modelParamsSchema,
      required: ['prompt', 'source'],
      properties: {
        ...modelParamsSchema.properties,
        source: { type: 'string', format: 'file' },
      },
    })
    const { data, workspace, options } = await studioSubmission(who, modelKey, mode)
    await expect(submitStudioCreation(data, workspace, options)).rejects.toMatchObject({
      code: 'STUDIO_REFERENCE_REQUIRED',
      status: 400,
      publicDetails: { field: 'source' },
    })

    const other = await account('studio-other-reference')
    const id = newId()
    await scoped(db, other.workspaceId).insert(file, {
      id,
      userId: other.userId,
      purpose: 'upload',
      status: 'ready',
      r2Key: `ws/${other.workspaceId}/${id}`,
      mime: 'image/png',
      size: 100,
    })
    await expect(
      submitStudioCreation({ ...data, params: { source: id } }, workspace, options),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })

    const videoId = newId()
    await scoped(db, who.workspaceId).insert(file, {
      id: videoId,
      userId: who.userId,
      purpose: 'upload',
      status: 'ready',
      r2Key: `ws/${who.workspaceId}/${videoId}`,
      mime: 'video/mp4',
      size: 100,
    })
    await expect(
      submitStudioCreation({ ...data, params: { source: videoId } }, workspace, options),
    ).rejects.toMatchObject({
      code: 'STUDIO_REFERENCE_INVALID',
      status: 400,
      publicDetails: { field: 'source' },
    })
    await expectNoMediaReservation(who.workspaceId)
  })

  it('余额不足返回 402 并回滚任务与预扣', async () => {
    const who = await account('studio-insufficient-credits')
    await hold(db, {
      workspaceId: who.workspaceId,
      userId: who.userId,
      amount: 98,
      refType: 'ai_message',
      refId: newId(),
    })
    const { data, workspace, options } = await studioSubmission(
      who,
      await model({}, 'fal', studioMode),
    )
    await expect(submitStudioCreation(data, workspace, options)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      status: 402,
      publicDetails: { estimatedCredits: 3, availableCredits: 2 },
    })
    await expectNoMediaReservation(who.workspaceId)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 2, held: 98 })
  })

  it('拒绝只读空间成员提交', async () => {
    const who = await account('studio-read-only')
    const { data, workspace, options } = await studioSubmission(
      who,
      await model({}, 'fal', studioMode),
    )
    await expect(
      submitStudioCreation(data, { ...workspace, workspaceReadOnly: true }, options),
    ).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY', status: 403 })
    await expectNoMediaReservation(who.workspaceId)
  })
})

// add-media-provider-fallback 5.1 / 5.3：受理时的候选筛选与回调归属。
describe.skipIf(!templateConfig.plugins.media)('media provider failover', () => {
  async function withProviders<T>(providers: string[], run: () => Promise<T>): Promise<T> {
    const media = templateConfig.plugins.media
    if (!media) throw new Error('The media plugin must be enabled')
    const enabled = media.providers
    Object.defineProperty(media, 'providers', { value: providers, configurable: true })
    try {
      return await run()
    } finally {
      Object.defineProperty(media, 'providers', { value: enabled, configurable: true })
    }
  }
  /** 主模型（fal，3 积分）+ Replicate 备用（9 积分，prompt 改名为 text）。 */
  async function chain(backupSchema?: Record<string, unknown>) {
    const primary = await model()
    const backup = await model(
      {},
      'replicate',
      'image',
      backupSchema ?? {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1 },
          num_images: { type: 'integer', minimum: 1, maximum: 4 },
        },
      },
    )
    // 备用更贵且已停用：仍可作为备用执行，用户只看到并支付主模型。
    await sql`update ai_model set pricing=${JSON.stringify({ mode: 'per_call', credits: 9 })}::jsonb,
      enabled=false where key=${backup}`
    await sql`update ai_model set fallbacks=${JSON.stringify([{ modelKey: backup, paramMap: { prompt: 'text' } }])}::jsonb
      where key=${primary}`
    return { primary, backup }
  }
  const replicateEnv = {
    MEDIA_WEBHOOK_SECRET: SECRET,
    REPLICATE_API_TOKEN: 'fixture-only',
    REPLICATE_WEBHOOK_SECRET: 'fixture-only',
  }

  it('主服务商未配置：直接由已配置的备用执行，定价快照、参数上限与预扣仍取主模型', async () => {
    const who = await account('failover-unconfigured')
    const { primary, backup } = await chain()
    const { deps } = dependencies()
    const { providerFactory: _factory, ...realDeps } = deps
    realDeps.env = replicateEnv
    const taskId = await withProviders(['fal', 'replicate'], () =>
      submitted(who, primary, realDeps),
    )
    const task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task).toMatchObject({
      modelKey: primary,
      provider: 'replicate',
      providerRequestKey: taskId,
      pricing: { mode: 'per_call', credits: 3 },
    })
    expect(task.providerAttempts).toEqual([
      {
        provider: 'replicate',
        modelKey: backup,
        providerModelId: 'fal-ai/fixture',
        at: expect.any(String),
      },
    ])
    expect(task.input).toMatchObject({
      params: { prompt: 'fixture', num_images: 1 },
      unitsLimit: 1,
      failover: {
        candidates: [
          { modelKey: backup, provider: 'replicate', params: { text: 'fixture', num_images: 1 } },
        ],
        skipped: [
          {
            modelKey: primary,
            provider: 'fal',
            failure: { kind: 'unavailable', code: 'AI_PROVIDER_NOT_CONFIGURED' },
          },
        ],
      },
    })
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })
  })

  it('备用按自身计量默认值会超过主模型数量时跳过（units_mismatch），主模型照常受理', async () => {
    const who = await account('failover-units')
    const { primary, backup } = await chain({
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 4, default: 4 },
        num_images: { type: 'integer', minimum: 1, maximum: 4 },
      },
      'x-media': { unitsParam: 'count' },
    })
    const { deps } = dependencies()
    const taskId = await withProviders(['fal', 'replicate'], () => submitted(who, primary, deps))
    const task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task.provider).toBe('fal')
    expect(task.input).toMatchObject({
      unitsLimit: 1,
      failover: {
        candidates: [{ modelKey: primary }],
        skipped: [
          {
            modelKey: backup,
            provider: 'replicate',
            failure: { kind: 'rejected_input', code: 'units_mismatch' },
          },
        ],
      },
    })
    expect((task.input.failover as { candidates: unknown[] }).candidates).toHaveLength(1)
  })

  it('同步服务商不作为备用：受理时跳过并记 synchronous_provider', async () => {
    const who = await account('failover-sync')
    const primary = await model()
    const backup = await model({}, 'workers-ai')
    await sql`update ai_model set fallbacks=${JSON.stringify([{ modelKey: backup }])}::jsonb
      where key=${primary}`
    const { deps } = dependencies()
    const taskId = await submitted(who, primary, deps)
    const task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task.provider).toBe('fal')
    expect(task.input.failover).toMatchObject({
      candidates: [{ modelKey: primary }],
      skipped: [
        {
          modelKey: backup,
          provider: 'workers-ai',
          failure: { kind: 'unavailable', code: 'synchronous_provider' },
        },
      ],
    })
  })

  it('所有候选都未配置或参数不兼容时按现有规则拒绝，不建任务也不预扣', async () => {
    const who = await account('failover-none')
    const { deps } = dependencies()
    const { providerFactory: _factory, ...realDeps } = deps
    realDeps.env = { MEDIA_WEBHOOK_SECRET: SECRET }
    const unconfigured = await chain()
    const response = await withProviders(['fal', 'replicate'], () =>
      submit(who, unconfigured.primary, realDeps),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'AI_PROVIDER_NOT_CONFIGURED' } })
    // 备用已配置但改名后的参数不满足其 schema（缺必填字段），视为不可用。
    realDeps.env = replicateEnv
    const incompatible = await chain({
      type: 'object',
      required: ['text', 'seed'],
      properties: { text: { type: 'string' }, seed: { type: 'integer' } },
    })
    expect(
      (await withProviders(['fal', 'replicate'], () => submit(who, incompatible.primary, realDeps)))
        .status,
    ).toBe(503)
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  /** 已从 fal（序号 0）切换到 Replicate（序号 1）的任务；按序号选服务商验签。 */
  async function switchedTask(options: { invalidReplicateSignature?: boolean } = {}) {
    const who = await account('failover-callback')
    const { primary, backup } = await chain()
    const parsed: string[] = []
    const fake = (id: string): MediaProvider => ({
      id,
      capabilities: { idempotentSubmit: false },
      submit: async () => ({ jobId: 'unused' }),
      getStatus: async () => ({ status: 'queued' }),
      parseWebhook: async () => {
        parsed.push(id)
        if (id === 'replicate' && options.invalidReplicateSignature)
          throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid provider signature')
        return {
          jobId: `${id}-job`,
          result: { outputs: [{ url: 'https://v3.fal.media/output.png', mime: 'image/png' }] },
        }
      },
    })
    const state = dependencies()
    state.deps.providerFactory = (_env, task) => fake(task.provider)
    const taskId = await submitted(who, primary, state.deps)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, {
      provider: 'replicate',
      providerJobId: 'replicate-job',
      providerRequestKey: `${taskId}:a1`,
      status: 'running',
      providerAttempts: [
        {
          provider: 'fal',
          modelKey: primary,
          providerModelId: 'fal-ai/fixture',
          jobId: 'fal-job',
          failure: { kind: 'rate_limited', code: 'FAL_RATE_LIMITED' },
          at: new Date().toISOString(),
        },
        {
          provider: 'replicate',
          modelKey: backup,
          providerModelId: 'fal-ai/fixture',
          jobId: 'replicate-job',
          at: new Date().toISOString(),
        },
      ],
    })
    const post = async (provider: string, attempt: number, url?: string) =>
      handleMediaWebhook(
        new Request(
          url ?? (await mediaCallbackUrl(APP_URL, SECRET, { id: taskId, provider, attempt })),
          { method: 'POST', body: '{}' },
        ),
        provider,
        state.deps,
      )
    return { who, taskId, parsed, post, state }
  }

  it('旧作业的晚到回调：fal 验签后 200 忽略，任务只采用当前 Replicate 作业的结果', async () => {
    const { who, taskId, parsed, post, state } = await switchedTask()
    // 旧格式地址（无序号）即序号 0，属于已切走的 fal 尝试。
    expect((await post('fal', 0)).status).toBe(200)
    expect(parsed).toEqual(['fal'])
    let task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task.callbackPayload).toBeNull()
    expect(state.counts().events).toBe(0)
    // 序号与路径中的服务商不符：拒绝，不验签。
    expect((await post('replicate', 0)).status).toBe(404)
    expect((await post('fal', 1)).status).toBe(404)
    expect(parsed).toEqual(['fal'])
    expect((await post('replicate', 1)).status).toBe(200)
    task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task.callbackPayload).toMatchObject({ jobId: 'replicate-job' })
    expect(parsed).toEqual(['fal', 'replicate'])
  })

  it('伪造服务商签名或篡改尝试序号：返回 4xx，任务不变', async () => {
    const { who, taskId, post, parsed } = await switchedTask({ invalidReplicateSignature: true })
    expect((await post('replicate', 1)).status).toBe(400)
    expect(parsed).toEqual(['replicate'])
    // 用序号 0 的任务签名冒充序号 1：任务签名不成立，不进入服务商验签。
    const legacy = new URL(
      await mediaCallbackUrl(APP_URL, SECRET, { id: taskId, provider: 'replicate' }),
    )
    legacy.searchParams.set('attempt', '1')
    expect((await post('replicate', 1, legacy.toString())).status).toBe(400)
    legacy.searchParams.set('attempt', '01')
    expect((await post('replicate', 1, legacy.toString())).status).toBe(400)
    expect(parsed).toEqual(['replicate'])
    const task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task).toMatchObject({ callbackPayload: null, status: 'running' })
  })
})
