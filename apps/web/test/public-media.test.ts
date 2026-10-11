import { env, type WorkflowStep } from 'cloudflare:workers'
import {
  createTaskMediaProvider,
  type MediaProvider,
  readMediaTaskInput,
  WORKERS_AI_IMAGE_MODEL,
} from '@saas/ai'
import { createAuth } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { getCreditBalance, grant } from '@saas/credits'
import { aiModel, aiTask, createDb, member, scoped } from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { newId } from '@saas/shared'
import { persistMediaOutputs } from '@saas/storage'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { runMediaTask } from '../../jobs/src/workflows/media-runner.ts'
import enApiDoc from '../content/docs/en/public-api.mdx?raw'
import zhApiDoc from '../content/docs/zh/public-api.mdx?raw'
import { createWorkspaceKey, editWorkspaceKey } from '../src/features/api-keys/service.ts'
import {
  handlePublicMediaDetail,
  handlePublicMediaSubmit,
  type PublicMediaDeps,
} from '../src/features/api-keys/tasks.ts'

const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const domain = `${newId()}.public-media.example`
const prefix = `public-media-${newId()}-`
const url = 'http://localhost:3000'
const config = defineTemplateConfig({
  app: { name: 'Test', url, supportEmail: 'support@example.test' },
  auth: { oauth: [], turnstile: false },
  features: { publicApi: true },
})
const auth = createAuth(
  { BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL: url },
  db,
  { config, sendEmail: async () => {} },
)
const entitlement = {
  key: 'fixture',
  sort: 0,
  features: { ...DEFAULT_FREE_FEATURES, publicApi: true, models: ['*'], maxConcurrentTasks: 3 },
}
const objectKeys: string[] = []
const authPost = (path: string, body: unknown) =>
  auth.handler(
    new Request(`${url}/api/auth${path}`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

async function owner(credits = 100) {
  const email = `${newId()}@${domain}`
  const response = await authPost('/sign-up/email', {
    email,
    password: 'correct-horse-battery-staple',
    name: 'Public Media Owner',
  })
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  const login = await authPost('/sign-in/email', {
    email,
    password: 'correct-horse-battery-staple',
  })
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const [workspace] = await sql<{ slug: string }[]>`
    select slug from organization where id=${user.id}`
  if (!workspace) throw new Error('Missing workspace')
  await grant(db, { workspaceId: user.id, source: 'admin', sourceRef: newId(), amount: credits })
  const headers = new Headers({ cookie })
  const key = await createWorkspaceKey(
    headers,
    { slug: workspace.slug, name: 'Media' },
    dependencies(),
  )
  return { id: user.id, slug: workspace.slug, headers, key }
}

async function model(providerId = 'fal') {
  const key = `${prefix}${newId()}`
  await db.insert(aiModel).values({
    key,
    kind: 'image',
    provider: providerId,
    providerModelId: providerId === 'workers-ai' ? WORKERS_AI_IMAGE_MODEL : 'fal-ai/fixture',
    pricing: { mode: 'per_call', credits: 3 },
    paramsSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        num_images: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
      },
    },
  })
  return key
}

const mediaResult = {
  outputs: [{ url: 'https://v3.fal.media/image.png', mime: 'image/png', width: 16, height: 16 }],
}
function provider(): MediaProvider {
  return {
    id: 'fal',
    capabilities: { idempotentSubmit: false },
    submit: vi.fn(async () => ({ jobId: 'fixture-image-job' })),
    getStatus: vi.fn(async () => ({ status: 'succeeded' as const, result: mediaResult })),
    parseWebhook: vi.fn(),
  }
}
function dependencies(overrides: Partial<PublicMediaDeps> = {}): PublicMediaDeps {
  return {
    db,
    auth,
    config,
    entitlements: async () => entitlement,
    rateLimiter: { limit: async () => ({ success: true }) },
    providerFactory: () => provider(),
    workflow: {
      create: vi.fn(async () => ({})),
      get: vi.fn(),
    } as unknown as PublicMediaDeps['workflow'],
    env: {
      FILES: env.FILES,
      APP_URL: url,
      MEDIA_WEBHOOK_SECRET: 'fixture-media-callback-secret',
      R2_ACCOUNT_ID: '00000000000000000000000000000000',
      R2_FILES_BUCKET: 'files',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
    },
    ...overrides,
  }
}
function submit(
  key: string,
  modelKey: string,
  deps = dependencies(),
  params: unknown = { prompt: 'Fixture' },
) {
  return handlePublicMediaSubmit(
    new Request(`${url}/api/v1/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelKey, params }),
    }),
    deps,
  )
}
function detail(key: string, id: string, deps = dependencies()) {
  return handlePublicMediaDetail(
    new Request(`${url}/api/v1/tasks/${id}`, { headers: { authorization: `Bearer ${key}` } }),
    id,
    deps,
  )
}
async function accepted(key: string, modelKey: string, deps = dependencies()) {
  const response = await submit(key, modelKey, deps)
  expect(response.status).toBe(202)
  const body = (await response.json()) as { id: string }
  expect(body).toMatchObject({ object: 'media.task', model: modelKey, status: 'queued' })
  return body.id
}
async function noReservation(workspaceId: string, available = 100) {
  expect(await scoped(db, workspaceId).count(aiTask)).toBe(0)
  expect(await sql`select id from credit_hold where workspace_id=${workspaceId}`).toHaveLength(0)
  expect(await getCreditBalance(db, workspaceId)).toMatchObject({ available, held: 0 })
}

afterAll(async () => {
  await env.FILES.delete(objectKeys)
  const ids = sql`select id from "user" where email like ${`%@${domain}`}`
  await sql`delete from file where workspace_id in (${ids})`
  await sql`delete from notification where workspace_id in (${ids})`
  await sql`delete from ai_task where workspace_id in (${ids})`
  await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id in (${ids}))`
  await sql`delete from credit_ledger where workspace_id in (${ids})`
  await sql`delete from credit_hold where workspace_id in (${ids})`
  await sql`delete from credit_grant where workspace_id in (${ids})`
  await sql`delete from credit_debt where workspace_id in (${ids})`
  await sql`delete from apikey where reference_id in (${ids})`
  await sql`delete from session where user_id in (${ids})`
  await sql`delete from account where user_id in (${ids})`
  await sql`delete from member where organization_id in (${ids}) or user_id in (${ids})`
  await sql`delete from organization where id in (${ids})`
  await sql`delete from "user" where id in (${ids})`
  await sql`delete from ai_model where key like ${`${prefix}%`}`
  await sql.end()
})

describe('公开 API 媒体任务与共用 Workflow', () => {
  it('通过假 AI 绑定执行同步图片，公开 API 可查询真实 R2 文件且积分结算一次', async () => {
    const who = await owner()
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const binding = { run: vi.fn(async () => ({ image: btoa(String.fromCharCode(...jpeg)) })) }
    const deps = dependencies()
    delete deps.providerFactory
    const { MEDIA_WEBHOOK_SECRET: _secret, ...envWithoutCallback } = deps.env
    deps.env = { ...envWithoutCallback, AI: binding }
    const taskId = await accepted(who.key.key, await model('workers-ai'), deps)
    const key = `ws/${who.id}/ai/${taskId}/0`
    objectKeys.push(key)
    const step = {
      async do(_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) {
        return ((callback ?? configOrCallback) as () => Promise<unknown>)()
      },
      waitForEvent: vi.fn(async () => {
        throw new Error('Sync output must not wait for callbacks')
      }),
    } as unknown as WorkflowStep
    const runnerDeps = {
      db,
      provider: (task: Parameters<typeof createTaskMediaProvider>[1]) =>
        createTaskMediaProvider(deps.env, task),
      params: async (task: Parameters<typeof readMediaTaskInput>[0]) =>
        readMediaTaskInput(task).params,
      callbackOrigin: url,
      callbackSecret: '',
      persist: (
        task: Parameters<typeof persistMediaOutputs>[0]['task'],
        result: Parameters<typeof persistMediaOutputs>[0]['result'],
      ) =>
        persistMediaOutputs({
          db,
          bucket: env.FILES,
          task,
          result,
          limits: {
            maxFileBytes: 1000,
            storageBytes: 1000,
            allowedMimeTypes: ['image/jpeg'],
            allowedHosts: [],
          },
        }),
      nonRetryable: (message: string) => new Error(message),
    }
    await runMediaTask(taskId, step, runnerDeps)
    await runMediaTask(taskId, step, runnerDeps)
    const response = await detail(who.key.key, taskId, deps)
    expect(await response.json()).toMatchObject({
      status: 'succeeded',
      credits_charged: 3,
      files: [{ mime: 'image/jpeg', size: jpeg.byteLength }],
    })
    expect(
      new Uint8Array((await (await env.FILES.get(key))?.arrayBuffer()) as ArrayBuffer),
    ).toEqual(jpeg)
    expect(binding.run).toHaveBeenCalledTimes(1)
    expect(step.waitForEvent).not.toHaveBeenCalled()
    expect(await getCreditBalance(db, who.id)).toMatchObject({ available: 97, held: 0 })
  })

  it('通过 Key 提交图片并轮询 queued/running/succeeded，真实转存和结算后返回五分钟下载地址', async () => {
    const mediaExample = (doc: string) => {
      const example = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)]
        .map(
          ([, body]) =>
            JSON.parse(body as string) as { model: string; params: Record<string, unknown> },
        )
        .find((value) => value.model === 'your-image-model-key' && value.params)
      if (!example) throw new Error('Missing media request example in public API docs')
      return example
    }
    const example = mediaExample(enApiDoc)
    expect(mediaExample(zhApiDoc)).toEqual(example)
    const who = await owner()
    const creator = await owner()
    await scoped(db, who.id).insert(member, { id: newId(), userId: creator.id, role: 'admin' })
    const key = await createWorkspaceKey(
      creator.headers,
      { slug: who.slug, name: 'Creator' },
      dependencies(),
    )
    const modelKey = await model()
    const deps = dependencies()
    const submission = await handlePublicMediaSubmit(
      new Request(`${url}/api/v1/tasks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...example, model: modelKey }),
      }),
      deps,
    )
    expect(submission.status).toBe(202)
    const submitted = (await submission.json()) as { id: string }
    expect(submitted).toMatchObject({ object: 'media.task', model: modelKey, status: 'queued' })
    const taskId = submitted.id
    expect(deps.workflow.create).toHaveBeenCalledWith({ id: taskId, params: { taskId } })
    const queued = await detail(key.key, taskId, deps)
    expect(await queued.json()).toMatchObject({ id: taskId, status: 'queued', files: [] })
    expect(await getCreditBalance(db, who.id)).toMatchObject({ available: 97, held: 3 })

    let waiting!: () => void
    let resume!: () => void
    const reachedWait = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const continueWorkflow = new Promise<void>((resolve) => {
      resume = resolve
    })
    const fake = provider()
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('png', { headers: { 'Content-Type': 'image/png', 'Content-Length': '3' } }),
    )
    const step = {
      async do(_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) {
        return ((callback ?? configOrCallback) as () => Promise<unknown>)()
      },
      async waitForEvent() {
        waiting()
        await continueWorkflow
        throw new Error('Fixture event timeout')
      },
    } as unknown as WorkflowStep
    objectKeys.push(`ws/${who.id}/ai/${taskId}/0`)
    // 测试侧注入 Provider 与持久步骤，仍执行生产 runner、存储及结算，不调用真实 fal.ai。
    const running = runMediaTask(taskId, step, {
      db,
      provider: () => fake,
      params: async (task) => readMediaTaskInput(task).params,
      callbackOrigin: url,
      callbackSecret: deps.env.MEDIA_WEBHOOK_SECRET as string,
      persist: (task, result) =>
        persistMediaOutputs({
          db,
          bucket: env.FILES,
          task,
          result,
          fetch: fetcher,
          limits: {
            maxFileBytes: 1000,
            storageBytes: 1000,
            allowedMimeTypes: ['image/png'],
            allowedHosts: ['*.fal.media'],
          },
        }),
      nonRetryable: (message) => new Error(message),
    })
    try {
      await reachedWait
      const response = await detail(key.key, taskId, deps)
      expect(await response.json()).toMatchObject({ status: 'running', files: [] })
    } finally {
      resume()
      await running
    }
    const succeeded = await detail(key.key, taskId, deps)
    expect(succeeded.status).toBe(200)
    expect(succeeded.headers.get('cache-control')).toBe('no-store')
    const body = (await succeeded.json()) as {
      files: { id: string; download_url: string; expires_at: number }[]
    }
    expect(body).toMatchObject({
      id: taskId,
      object: 'media.task',
      model: modelKey,
      kind: 'image',
      status: 'succeeded',
      credits_charged: 3,
      error: null,
      created: expect.any(Number),
      finished_at: expect.any(Number),
      files: [{ mime: 'image/png', size: 3, width: 16, height: 16, duration: null }],
    })
    expect(body.files).toHaveLength(1)
    const output = body.files[0]
    if (!output) throw new Error('Missing output file')
    const download = new URL(output.download_url)
    expect(download.hostname).toBe('00000000000000000000000000000000.r2.cloudflarestorage.com')
    expect(download.pathname).toBe(`/files/ws/${who.id}/ai/${taskId}/0`)
    expect(download.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(download.searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(output.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 295)
    expect(output.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300)
    expect((await env.FILES.get(objectKeys.at(-1) as string))?.size).toBe(3)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await getCreditBalance(db, who.id)).toMatchObject({ available: 97, held: 0 })
    const [task] = await scoped(db, who.id).select(aiTask)
    expect(task?.userId).toBe(creator.id)
    for (const hidden of ['providerJobId', 'callbackPayload', 'holdId', 'input'])
      expect(body).not.toHaveProperty(hidden)
  })

  it('关闭功能时提交和查询均返回 404', async () => {
    const who = await owner()
    const deps = dependencies({
      config: defineTemplateConfig({ app: config.app, features: { publicApi: false } }),
    })
    expect((await submit(who.key.key, 'unused', deps)).status).toBe(404)
    expect((await detail(who.key.key, newId(), deps)).status).toBe(404)
    await noReservation(who.id)
  })

  it('撤销 Key 后提交和查询均返回 401', async () => {
    const who = await owner()
    const deps = dependencies()
    const taskId = await accepted(who.key.key, await model(), deps)
    await editWorkspaceKey(who.headers, { slug: who.slug, id: who.key.id, revoke: true }, deps)
    for (const response of [
      await submit(who.key.key, 'unused', deps),
      await detail(who.key.key, taskId, deps),
    ]) {
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        error: { code: 'INVALID_API_KEY', type: 'authentication_error' },
      })
    }
    expect(await scoped(db, who.id).count(aiTask)).toBe(1)
  })

  it('其他空间的 Key 查询任务返回 404', async () => {
    const who = await owner()
    const other = await owner()
    const taskId = await accepted(who.key.key, await model())
    expect((await detail(other.key.key, taskId)).status).toBe(404)
    expect((await detail(who.key.key, taskId)).status).toBe(200)
  })

  it('非法模型参数在创建任务和预扣之前被拒绝', async () => {
    const who = await owner()
    const deps = dependencies()
    const response = await submit(who.key.key, await model(), deps, {
      prompt: 'Fixture',
      num_images: 10,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
    await noReservation(who.id)
    expect(deps.workflow.create).not.toHaveBeenCalled()
  })

  it('提交和查询分别按 Key 与空间限流，返回 429 和 Retry-After', async () => {
    const who = await owner()
    for (const blocked of ['key', 'workspace']) {
      const keys: string[] = []
      const deps = dependencies({
        rateLimiter: {
          limit: async ({ key }) => {
            keys.push(key)
            return { success: !key.startsWith(`api:${blocked}:`) }
          },
        },
      })
      for (const call of [
        () => submit(who.key.key, 'unused', deps),
        () => detail(who.key.key, newId(), deps),
      ]) {
        keys.length = 0
        const response = await call()
        expect(response.status).toBe(429)
        expect(response.headers.get('retry-after')).toBe('60')
        expect(keys).toEqual(
          blocked === 'key'
            ? [`api:key:${who.key.id}`]
            : [`api:key:${who.key.id}`, `api:workspace:${who.id}`],
        )
      }
    }
    await noReservation(who.id)
  })

  it('真实并发提交共用空间上限，只为获准的任务预扣', async () => {
    const who = await owner()
    const modelKey = await model()
    const deps = dependencies({
      entitlements: async () => ({
        ...entitlement,
        features: { ...entitlement.features, maxConcurrentTasks: 1 },
      }),
    })
    const responses = await Promise.all([
      submit(who.key.key, modelKey, deps),
      submit(who.key.key, modelKey, deps),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([202, 403])
    expect(await scoped(db, who.id).count(aiTask)).toBe(1)
    expect(await getCreditBalance(db, who.id)).toMatchObject({ available: 97, held: 3 })
    expect(deps.workflow.create).toHaveBeenCalledTimes(1)
  })

  it('模型权益不足时拒绝提交，不产生预扣', async () => {
    const who = await owner()
    const deps = dependencies({
      entitlements: async () => ({
        ...entitlement,
        features: { ...entitlement.features, models: [] },
      }),
    })
    const response = await submit(who.key.key, await model(), deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'UPGRADE_REQUIRED' } })
    await noReservation(who.id)
  })

  it('余额不足时事务回滚任务与预扣，返回 402', async () => {
    const who = await owner(1)
    const deps = dependencies()
    const response = await submit(who.key.key, await model(), deps)
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_CREDITS' } })
    await noReservation(who.id, 1)
    expect(deps.workflow.create).not.toHaveBeenCalled()
  })
})
