import { env } from 'cloudflare:workers'
import {
  createTaskMediaProvider,
  FalProviderError,
  initialMediaFaultProof,
  type MediaAcceptanceFault,
  type MediaAcceptanceFaultProof,
  type MediaProvider,
  type MediaResult,
  type MediaStatus,
  mediaAttemptRequest,
  mediaFaultPolicy,
  ReplicateProviderError,
  settleMediaTask,
  switchMediaTaskAttempt,
  type TaskMediaProvider,
  updateMediaFaultProof,
} from '@saas/ai'
import { getCreditBalance, grant, hold } from '@saas/credits'
import { type AiPricingJson, aiTask, createDb, member, organization, scoped, user } from '@saas/db'
import { NonRetryableError, type WorkflowStep } from '@saas/platform'
import { createCloudflareWorkflowStep } from '@saas/platform/cloudflare'
import { AppError, MEDIA_DONE_EVENT } from '@saas/shared'
import { persistMediaOutputs } from '@saas/storage'
import { createCloudflareMediaCopier, createCloudflareStorage } from '@saas/storage/cloudflare'
import { afterAll, expect, it, vi } from 'vitest'
import documented from '../../../packages/ai/src/media/fixtures/fal.documented.json'
import {
  type MediaRunnerDeps,
  runMediaTask,
  submitMediaOnce,
} from '../../../plugins/media/src/jobs/media-runner.ts'

const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const id = () => crypto.randomUUID()
const fixtures: { workspaceId: string; taskId: string; holdId: string }[] = []
const result: MediaResult = {
  outputs: documented.image.images.map((output) => ({
    url: output.url,
    mime: output.content_type,
    width: output.width,
    height: output.height,
  })),
}
const limits = {
  maxFileBytes: 1000,
  storageBytes: 1000,
  allowedMimeTypes: ['image/png'],
  allowedHosts: ['*.fal.media'],
}

async function fixture(pricing: AiPricingJson = { mode: 'per_call', credits: 15 }) {
  const workspaceId = id()
  const taskId = id()
  await db.insert(user).values({
    id: workspaceId,
    name: 'Workflow',
    email: `${workspaceId}@media-workflow.example.test`,
  })
  await db.insert(organization).values({ id: workspaceId, name: 'Workflow', slug: workspaceId })
  await db
    .insert(member)
    .values({ id: id(), userId: workspaceId, organizationId: workspaceId, role: 'owner' })
  await grant(db, { workspaceId, source: 'admin', sourceRef: id(), amount: 100 })
  const reservation = await hold(db, {
    workspaceId,
    userId: workspaceId,
    amount: 15,
    refType: 'ai_task',
    refId: taskId,
  })
  const f = { workspaceId, taskId, holdId: reservation.id }
  fixtures.push(f)
  await db.insert(aiTask).values({
    id: taskId,
    workspaceId,
    userId: workspaceId,
    kind: 'image',
    modelKey: 'frozen-image',
    pricing,
    input: {
      params: { num_images: 5 },
      providerModelId: 'fake/image',
      unitsLimit: 5,
      fileParams: [],
      storageBytes: 1000,
    },
    provider: 'fake',
    providerRequestKey: taskId,
    holdId: reservation.id,
    deadlineAt: new Date(Date.now() + 2 * 60 * 60_000),
  })
  return f
}

function provider() {
  return {
    id: 'fake',
    capabilities: { idempotentSubmit: false },
    submit: vi.fn<MediaProvider['submit']>(async () => ({ jobId: 'job-fixture' })),
    getStatus: vi.fn<MediaProvider['getStatus']>(async () => ({ status: 'succeeded', result })),
    parseWebhook: vi.fn<MediaProvider['parseWebhook']>(),
  } satisfies MediaProvider
}

function harness(
  fakeProvider: TaskMediaProvider,
  options: {
    replay?: string[]
    onWait?: () => Promise<void>
    onSleep?: (duration: number, now: number) => number | Promise<void>
    start?: number
    /** 首次运行已记录的步骤结果：模拟 Workflow 重放时直接返回缓存值。 */
    cached?: Record<string, unknown>
    /** 按步骤名投递的事件 payload；返回 undefined 时等待超时。 */
    events?: (name: string) => Promise<unknown> | unknown
  } = {},
) {
  let now = options.start ?? Date.now()
  const names: string[] = []
  const sleeps: number[] = []
  const waits: { type: string; timeoutMs: number }[] = []
  const values = new Map<string, unknown>()
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      // 沿用storage集成夹具，字节只进入本地R2，不请求服务商。
      new Response('png', { headers: { 'Content-Type': 'image/png', 'Content-Length': '3' } }),
  )
  const deps: MediaRunnerDeps = {
    db,
    provider: () => fakeProvider,
    params: async (task) => task.input.params as Record<string, unknown>,
    callbackOrigin: 'https://app.example.test',
    callbackSecret: 'workflow-test-secret',
    persist: (task, media) =>
      persistMediaOutputs({
        db,
        storage: createCloudflareStorage(env),
        copyOutput: createCloudflareMediaCopier(env.FILES, { fetch: fetcher }),
        task,
        result: media,
        limits,
      }),
    now: () => now,
  }
  const step = {
    async do(name: string, configOrCallback: unknown, maybeCallback?: () => Promise<unknown>) {
      names.push(name)
      if (options.cached && Object.hasOwn(options.cached, name)) return options.cached[name]
      const callback = (maybeCallback ?? configOrCallback) as () => Promise<unknown>
      const config = maybeCallback
        ? (configOrCallback as { retries?: { limit: number } })
        : undefined
      for (let attempt = 0; ; attempt++) {
        try {
          const value = await callback()
          // 模拟成功副作用后step结果未记录，重放相同回调。
          const returned = options.replay?.includes(name) ? await callback() : value
          values.set(name, returned)
          return returned
        } catch (error) {
          if (error instanceof NonRetryableError || attempt >= (config?.retries?.limit ?? 0))
            throw error
        }
      }
    },
    async waitForEvent(name: string, config: { type: string; timeoutMs: number }) {
      names.push(name)
      const payload = await options.events?.(name)
      if (payload !== undefined) {
        now += 1_000
        return { type: config.type, payload, timestamp: new Date(now) }
      }
      waits.push(config)
      now += config.timeoutMs
      await options.onWait?.()
      throw new Error('Event timeout')
    },
    async sleep(_name: string, duration: number) {
      sleeps.push(duration)
      const elapsed = await options.onSleep?.(duration, now)
      now += elapsed ?? duration
    },
  } as unknown as WorkflowStep
  return { deps, step, names, sleeps, waits, fetcher, values, now: () => now }
}

async function state(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  const [reservation] = await sql<{ status: string; captured_amount: number }[]>`
    select status, captured_amount from credit_hold where id=${f.holdId}`
  const ledger = await sql<{ delta: number }[]>`
    select delta from credit_ledger where workspace_id=${f.workspaceId} and type='consume'`
  const notices = await sql<{ type: string }[]>`
    select type from notification where workspace_id=${f.workspaceId}`
  const files = await sql<{ id: string; status: string; r2_key: string; size: number }[]>`
    select id, status, r2_key, size::integer as size from file where workspace_id=${f.workspaceId}`
  const [invariant] = await sql<{ valid: boolean }[]>`
    select (select coalesce(sum(delta),0) from credit_ledger where workspace_id=${f.workspaceId}) =
      (select coalesce(sum(remaining),0) from credit_grant where workspace_id=${f.workspaceId} and status='active') +
      (select coalesce(sum(amount),0) from credit_hold where workspace_id=${f.workspaceId} and status='held') -
      (select coalesce(sum(amount),0) from credit_debt where workspace_id=${f.workspaceId}) as valid`
  expect(invariant?.valid).toBe(true)
  return {
    task,
    hold: reservation,
    ledger,
    notices,
    files,
    balance: await getCreditBalance(db, f.workspaceId),
  }
}

async function refunded(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await state(f)).toMatchObject({
    task: { status: 'failed', creditsCharged: 0 },
    hold: { status: 'released', captured_amount: 0 },
    ledger: [],
    notices: [{ type: 'ai_task.failed' }],
    balance: { available: 100, held: 0 },
  })
}

async function succeeded(f: Awaited<ReturnType<typeof fixture>>, size = 3) {
  expect(await state(f)).toMatchObject({
    task: { status: 'succeeded', creditsCharged: 15 },
    hold: { status: 'captured', captured_amount: 15 },
    ledger: [{ delta: -15 }],
    notices: [{ type: 'ai_task.succeeded' }],
    files: [{ status: 'ready', size }],
    balance: { available: 85, held: 0 },
  })
}

async function faultFixture(mode: MediaAcceptanceFault['mode']) {
  const f = await fixture()
  const start = Date.now()
  const workers = mode.startsWith('workers-')
  const fault: MediaAcceptanceFault = {
    mode,
    policyVersion: 1,
    authorizedAdmin: true,
    deadlineMs: mode.endsWith('timeout') ? 60_000 : 20 * 60_000,
    initialWaitMs: workers ? 0 : 5_000,
    barrierMs: mode === 'fal-callback-early' ? 10 * 60_000 : 0,
  }
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    modelKey: `acceptance-fault-${mode}`,
    provider: workers ? 'workers-ai' : 'fal',
    input: {
      ...task.input,
      params: { image_size: 'square', num_images: 1 },
      providerModelId: workers ? '@cf/black-forest-labs/flux-1-schnell' : 'fal-ai/flux/schnell',
      unitsLimit: 1,
      acceptanceFault: { ...fault },
      acceptanceFaultProof: { ...initialMediaFaultProof(fault) },
    },
    createdAt: new Date(start),
    deadlineAt: new Date(start + fault.deadlineMs),
  })
  return { ...f, start, fault }
}

function faultProvider() {
  return {
    ...provider(),
    id: 'fal',
    cancel: vi.fn<NonNullable<MediaProvider['cancel']>>(async () => {}),
  }
}

function enableFaults(h: ReturnType<typeof harness>) {
  h.deps.faultEnv = { SENTRY_ENVIRONMENT: 'staging', AI_FAULT_INJECTION: 'enabled' }
}

async function faultProof(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  return task.input.acceptanceFaultProof as MediaAcceptanceFaultProof | undefined
}

async function lateReplay(f: Awaited<ReturnType<typeof fixture>>, h: ReturnType<typeof harness>) {
  const before = await state(f)
  await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    callbackPayload: { jobId: 'job-fixture', result },
  })
  await settleMediaTask(db, {
    workspaceId: f.workspaceId,
    taskId: f.taskId,
    outcome: 'succeeded',
    result,
    files: [],
  })
  await runMediaTask(f.taskId, h.step, h.deps)
  const after = await state(f)
  expect(after.task.status).toBe(before.task.status)
  expect(after.task.creditsCharged).toBe(before.task.creditsCharged)
  expect(after.task.providerJobId).toBe(before.task.providerJobId)
  expect(after.task.output).toEqual(before.task.output)
  expect(after.task.errorCode).toBe(before.task.errorCode)
  expect(after.hold).toEqual(before.hold)
  expect(after.ledger).toEqual(before.ledger)
  expect(after.notices).toEqual(before.notices)
  expect(after.files).toEqual(before.files)
  expect(after.balance).toEqual(before.balance)
}

afterAll(async () => {
  for (const { workspaceId: ws, taskId } of fixtures) {
    await env.FILES.delete(`ws/${ws}/ai/${taskId}/0`)
    await sql`delete from notification where workspace_id=${ws}`
    await sql`delete from file where workspace_id=${ws}`
    await sql`delete from ai_task where workspace_id=${ws}`
    await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id=${ws})`
    await sql`delete from credit_ledger where workspace_id=${ws}`
    await sql`delete from credit_hold where workspace_id=${ws}`
    await sql`delete from credit_grant where workspace_id=${ws}`
    await sql`delete from credit_debt where workspace_id=${ws}`
    await sql`delete from member where organization_id=${ws}`
    await sql`delete from organization where id=${ws}`
    await sql`delete from "user" where id=${ws}`
  }
  await sql.end()
})

it('lost submission response keeps the hold, waits the configured period without replay, then refunds', async () => {
  const f = await fixture()
  const fake = provider()
  fake.submit.mockRejectedValue(new Error('Accepted by provider, response lost'))
  const h = harness(fake)
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  expect(await submitMediaOnce(task, h.deps)).toMatchObject({ uncertain: true, stopped: false })
  // 不确定提交不立即退款：预扣保留，任务保持 running 并带标记。
  const waiting = await state(f)
  expect(waiting.task).toMatchObject({
    status: 'running',
    providerJobId: null,
    errorCode: 'MEDIA_SUBMISSION_UNCERTAIN',
    output: { submissionAttempted: true },
  })
  expect(waiting.hold?.status).toBe('held')
  expect(waiting.balance).toMatchObject({ available: 85, held: 15 })
  expect(await submitMediaOnce(task, h.deps)).toMatchObject({ uncertain: true })
  expect(await runMediaTask(f.taskId, h.step, h.deps)).toEqual({
    taskId: f.taskId,
    status: 'failed',
  })
  expect(h.waits).toEqual([{ type: MEDIA_DONE_EVENT, timeoutMs: 3600_000 }])
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).not.toHaveBeenCalled()
  expect((await state(f)).task.errorCode).toBe('MEDIA_SUBMISSION_UNCERTAIN')
  await refunded(f)
})

it('uncertain submission settles normally when a verified callback arrives within the wait', async () => {
  const f = await fixture()
  const fake = provider()
  fake.submit.mockRejectedValue(new Error('Accepted by provider, response lost'))
  const h = harness(fake, {
    onWait: async () => {
      // 回调路由验签后写入的状态：采用回调作业 ID 并清除标记。
      await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
        providerJobId: 'job-callback',
        errorCode: null,
        errorMessage: null,
        callbackPayload: { jobId: 'job-callback', result },
      })
    },
  })
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.waits).toEqual([{ type: MEDIA_DONE_EVENT, timeoutMs: 3600_000 }])
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).not.toHaveBeenCalled()
  expect((await state(f)).task.providerJobId).toBe('job-callback')
  await succeeded(f)
})

it('uncertain submission adopts a callback stored before the marker and polls when it has no result', async () => {
  const f = await fixture()
  const fake = provider()
  fake.submit.mockImplementation(async () => {
    await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
      callbackPayload: { jobId: 'job-early' },
    })
    throw new Error('Accepted by provider, response lost')
  })
  const h = harness(fake)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).toHaveBeenCalledWith('job-early')
  expect((await state(f)).task).toMatchObject({ providerJobId: 'job-early', errorCode: null })
  await succeeded(f)
})

it('persisted job and output survive step replays, charge capped usage once and create one file', async () => {
  const f = await fixture({ mode: 'per_unit', unit: 'image', perUnit: 3 })
  const fake = provider()
  fake.submit.mockResolvedValue({ jobId: 'job-fixture', sync: { ...result, usage: { images: 6 } } })
  const h = harness(fake, { replay: ['submit', 'persist', 'settle-and-notify'] })
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.submit).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: f.taskId }))
  expect((await state(f)).task.providerJobId).toBe('job-fixture')
  expect(h.fetcher).toHaveBeenCalledTimes(1)
  expect((await state(f)).files).toHaveLength(1)
  expect((await env.FILES.get(`ws/${f.workspaceId}/ai/${f.taskId}/0`))?.size).toBe(3)
  await succeeded(f)
})

it('keeps cancellation retry evidence when a late submission returns and provider cancellation fails', async () => {
  const f = await fixture()
  const fake: MediaProvider = {
    ...provider(),
    submit: async () => {
      await settleMediaTask(db, {
        workspaceId: f.workspaceId,
        taskId: f.taskId,
        outcome: 'canceled',
        error: { code: 'MEDIA_CANCEL_PENDING', message: 'pending' },
      })
      return { jobId: 'late-job' }
    },
    cancel: async () => {
      throw new Error('Provider unavailable')
    },
  }
  const h = harness(fake)
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  expect(await submitMediaOnce(task, h.deps)).toMatchObject({ jobId: 'late-job', stopped: true })
  const actual = await state(f)
  expect(actual.task).toMatchObject({
    status: 'canceled',
    providerJobId: 'late-job',
    errorCode: 'MEDIA_CANCEL_PENDING',
  })
  expect(actual.hold?.status).toBe('released')
  expect(actual.ledger).toEqual([])
  expect(actual.balance).toMatchObject({ available: 100, held: 0 })
})

it('callback written before the wait completes without waiting or polling', async () => {
  const f = await fixture()
  const fake = provider()
  fake.submit.mockImplementation(async () => {
    await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
      callbackPayload: { jobId: 'job-fixture', result },
    })
    return { jobId: 'job-fixture' }
  })
  const h = harness(fake)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.waits).toHaveLength(0)
  expect(fake.getStatus).not.toHaveBeenCalled()
  await succeeded(f)
})

it('lost event with a callback committed during the wait is recovered by the post-timeout check', async () => {
  const f = await fixture()
  const fake = provider()
  const h = harness(fake, {
    onWait: async () => {
      await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
        callbackPayload: { jobId: 'job-fixture', result },
      })
    },
  })
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.waits).toEqual([{ type: MEDIA_DONE_EVENT, timeoutMs: 15 * 60_000 }])
  expect(fake.getStatus).not.toHaveBeenCalled()
  await succeeded(f)
})

it('missing callback polls after 15 minutes with exponential 30-second to 5-minute delays', async () => {
  const f = await fixture()
  const fake = provider()
  const pending: MediaStatus = { status: 'running' }
  for (let index = 0; index < 6; index++) fake.getStatus.mockResolvedValueOnce(pending)
  const h = harness(fake)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.waits[0]?.timeoutMs).toBe(15 * 60_000)
  expect(h.sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000])
  expect(fake.getStatus).toHaveBeenCalledTimes(7)
  expect(fake.getStatus).toHaveBeenCalledWith('job-fixture')
  await succeeded(f)
})

it('untrusted provider output is rejected by real storage without fetching and refunds all credits', async () => {
  const f = await fixture()
  const fake = provider()
  fake.submit.mockResolvedValue({
    jobId: 'job-fixture',
    sync: { outputs: [{ url: 'https://evil.example.test/image.png', mime: 'image/png' }] },
  })
  const h = harness(fake)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.fetcher).not.toHaveBeenCalled()
  expect((await state(f)).files).toEqual([])
  expect((await state(f)).task.errorCode).toBe('MEDIA_URL_NOT_ALLOWED')
  await refunded(f)
})

it('a still-running provider reaches the hard deadline, stops polling and refunds everything', async () => {
  const f = await fixture()
  const fake = provider()
  fake.getStatus.mockResolvedValue({ status: 'running' })
  const start = Date.now()
  await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    deadlineAt: new Date(start + 15 * 60_000 + 45_000),
  })
  const h = harness(fake, { start })
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.sleeps).toEqual([30_000, 15_000])
  expect(fake.getStatus).toHaveBeenCalledTimes(2)
  expect((await state(f)).task.errorCode).toBe('MEDIA_TIMEOUT')
  expect(h.fetcher).not.toHaveBeenCalled()
  await refunded(f)
})

async function workersAi(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    provider: 'workers-ai',
  })
  const binding = {
    run: vi.fn(async () => ({ image: 'iVBORw0KGgo=' })),
  }
  return { binding, provider: createTaskMediaProvider({ AI: binding }, task, ['workers-ai']) }
}

it('Workers AI persists and settles inside submit, replaying only file IDs without duplicate charges', async () => {
  const f = await fixture()
  const fake = await workersAi(f)
  const h = harness(fake.provider, { replay: ['submit', 'settle-and-notify'] })
  h.deps.callbackSecret = ''
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.binding.run).toHaveBeenCalledTimes(2)
  expect(fake.binding.run).toHaveBeenCalledWith('fake/image', { num_images: 5 })
  const actual = await state(f)
  expect(h.values.get('submit')).toEqual(actual.files.map((file) => file.id))
  expect(actual.files).toHaveLength(1)
  expect(actual.task.output?.usage).toEqual({ images: 1 })
  expect(JSON.stringify(actual.task.output)).not.toContain('body')
  expect(h.names).toEqual(['load-task', 'submit', 'settle-and-notify'])
  expect(h.fetcher).not.toHaveBeenCalled()
  await succeeded(f, 8)
})

it('Workers AI inference failure refunds the whole hold without persisting any file', async () => {
  const f = await fixture()
  const fake = await workersAi(f)
  fake.binding.run.mockRejectedValue(new Error('Inference unavailable'))
  const h = harness(fake.provider)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.binding.run).toHaveBeenCalledTimes(1)
  const actual = await state(f)
  expect(actual.task.errorCode).toBe('WORKERS_AI_GENERATION_FAILED')
  expect(actual.files).toEqual([])
  await refunded(f)
})

const upstreamError = (message: string, name = 'InferenceUpstreamError') =>
  Object.assign(new Error(message), { name })

it('Workers AI capacity errors are retried by the submit step and charge only the success once', async () => {
  const f = await fixture()
  const fake = await workersAi(f)
  fake.binding.run
    .mockRejectedValueOnce(upstreamError('3040: Capacity temporarily exceeded, please try again.'))
    .mockRejectedValueOnce(upstreamError('3007: Request timeout'))
  const h = harness(fake.provider)
  h.deps.callbackSecret = ''
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.binding.run).toHaveBeenCalledTimes(3)
  expect(h.names).toEqual(['load-task', 'submit', 'settle-and-notify'])
  await succeeded(f, 8)
})

it('Workers AI deterministic rejection is not retried and keeps the safe upstream summary', async () => {
  const f = await fixture()
  const fake = await workersAi(f)
  fake.binding.run.mockRejectedValue(
    upstreamError('8007: Input prompt contains NSFW content. fixture prompt', 'AiError'),
  )
  const h = harness(fake.provider)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.binding.run).toHaveBeenCalledTimes(1)
  const actual = await state(f)
  expect(actual.task).toMatchObject({
    errorCode: 'WORKERS_AI_GENERATION_FAILED',
    errorMessage: 'Workers AI image generation failed (AiError 8007)',
  })
  expect(actual.files).toEqual([])
  await refunded(f)
})

it('Workers AI 8007 keeps its safe code and summary through the Cloudflare step adapter', async () => {
  const f = await fixture()
  const fake = await workersAi(f)
  fake.binding.run.mockRejectedValue(
    upstreamError('8007: Input prompt contains NSFW content. fixture prompt', 'AiError'),
  )
  const h = harness(fake.provider)
  // 模拟 CF 引擎：NonRetryableError 不再重试，回调异常经 RPC 复制后只剩 name/message。
  const engine = {
    async do(_name: string, configOrCallback: unknown, maybeCallback?: () => Promise<unknown>) {
      const callback = (maybeCallback ?? configOrCallback) as () => Promise<unknown>
      const limit = maybeCallback
        ? ((configOrCallback as { retries?: { limit: number } }).retries?.limit ?? 0)
        : 0
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback()
        } catch (error) {
          const { name, message } = error as Error
          if (name === 'NonRetryableError' || attempt >= limit)
            throw Object.assign(new Error(message), { name })
        }
      }
    },
  }
  await runMediaTask(f.taskId, createCloudflareWorkflowStep(engine as never), h.deps)
  expect(fake.binding.run).toHaveBeenCalledTimes(1)
  const actual = await state(f)
  expect(actual.task).toMatchObject({
    errorCode: 'WORKERS_AI_GENERATION_FAILED',
    errorMessage: 'Workers AI image generation failed (AiError 8007)',
  })
  expect(actual.files).toEqual([])
  await refunded(f)
})

it('fal 明确拒绝（401）经 Cloudflare step 适配器不重试并保留原错误码', async () => {
  const f = await fixture()
  const fake = provider()
  fake.submit.mockRejectedValue(
    new FalProviderError('FAL_HTTP_ERROR', 'fal.ai HTTP request failed (401)', 401, 'rejected'),
  )
  const h = harness(fake)
  // 模拟 CF 引擎：NonRetryableError 不再重试，回调异常经 RPC 复制后只剩 name/message。
  const engine = {
    async do(_name: string, configOrCallback: unknown, maybeCallback?: () => Promise<unknown>) {
      const callback = (maybeCallback ?? configOrCallback) as () => Promise<unknown>
      const limit = maybeCallback
        ? ((configOrCallback as { retries?: { limit: number } }).retries?.limit ?? 0)
        : 0
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback()
        } catch (error) {
          const { name, message } = error as Error
          if (name === 'NonRetryableError' || attempt >= limit)
            throw Object.assign(new Error(message), { name })
        }
      }
    },
  }
  await runMediaTask(f.taskId, createCloudflareWorkflowStep(engine as never), h.deps)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect((await state(f)).task).toMatchObject({
    status: 'failed',
    errorCode: 'FAL_HTTP_ERROR',
    providerJobId: null,
  })
  await refunded(f)
})

it('Workers AI transient errors stop after the retry limit and refund the whole hold', async () => {
  const f = await fixture()
  const fake = await workersAi(f)
  fake.binding.run.mockRejectedValue(upstreamError('3040: Capacity temporarily exceeded'))
  const h = harness(fake.provider)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.binding.run).toHaveBeenCalledTimes(3)
  expect((await state(f)).task.errorCode).toBe('WORKERS_AI_GENERATION_FAILED')
  await refunded(f)
})

it('cancellation during Workers AI inference prevents storage and late workflow replay stops', async () => {
  const f = await fixture()
  const fake = await workersAi(f)
  fake.binding.run.mockImplementation(async () => {
    await settleMediaTask(db, {
      workspaceId: f.workspaceId,
      taskId: f.taskId,
      outcome: 'canceled',
    })
    return { image: 'iVBORw0KGgo=' }
  })
  const h = harness(fake.provider)
  expect(await runMediaTask(f.taskId, h.step, h.deps)).toEqual({
    taskId: f.taskId,
    status: 'canceled',
  })
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.binding.run).toHaveBeenCalledTimes(1)
  const actual = await state(f)
  expect(actual.files).toEqual([])
  expect(actual.hold?.status).toBe('released')
  expect(actual.ledger).toEqual([])
  expect(actual.balance).toMatchObject({ available: 100, held: 0 })
  expect(await env.FILES.head(`ws/${f.workspaceId}/ai/${f.taskId}/0`)).toBeNull()
})

it.each(['workers-error', 'workers-timeout'] as const)(
  '%s is injected without invoking Workers AI or persisting bytes and refunds once',
  async (mode) => {
    const f = await faultFixture(mode)
    const fake = await workersAi(f)
    const h = harness(fake.provider, {
      start: f.start,
      replay: ['fail-and-notify'],
      onSleep: async (_duration, now) => {
        const actual = await state(f)
        expect(now).toBeLessThan(f.start + f.fault.deadlineMs)
        expect(actual.task.status).toBe('running')
        expect(actual.hold?.status).toBe('held')
        expect(actual.files).toEqual([])
        expect(fake.binding.run).not.toHaveBeenCalled()
      },
    })
    enableFaults(h)
    const persist = vi.spyOn(h.deps, 'persist')
    expect(await runMediaTask(f.taskId, h.step, h.deps)).toEqual({
      taskId: f.taskId,
      status: 'failed',
    })
    expect(await faultProof(f)).toMatchObject({
      mode,
      policyVersion: 1,
      injected: true,
      realProviderCalled: false,
      submitAttempts: 0,
      pollCount: 0,
    })
    if (mode === 'workers-timeout') {
      expect(h.sleeps).toEqual([60_000])
      expect(h.now()).toBe(f.start + 60_000)
      expect((await state(f)).task.errorCode).toBe('MEDIA_TIMEOUT')
    } else {
      expect(h.sleeps).toEqual([])
      expect(h.now()).toBe(f.start)
    }
    expect(fake.binding.run).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(h.fetcher).not.toHaveBeenCalled()
    await refunded(f)
    await lateReplay(f, h)
    expect(fake.binding.run).not.toHaveBeenCalled()
  },
)

it('fal callback loss wraps one original submission and recovers via polling with one output and charge', async () => {
  const f = await faultFixture('fal-callback-lost')
  const fake = faultProvider()
  const h = harness(fake, {
    start: f.start,
    replay: ['submit', 'persist', 'settle-and-notify'],
  })
  enableFaults(h)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.submit).toHaveBeenCalledWith({
    modelId: 'fal-ai/flux/schnell',
    params: { image_size: 'square', num_images: 1 },
    idempotencyKey: f.taskId,
  })
  expect(h.waits).toEqual([{ type: MEDIA_DONE_EVENT, timeoutMs: 5_000 }])
  expect(fake.getStatus).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).toHaveBeenCalledWith('job-fixture')
  expect(await faultProof(f)).toMatchObject({
    mode: 'fal-callback-lost',
    policyVersion: 1,
    injected: true,
    realProviderCalled: true,
    realRequestId: 'job-fixture',
    submitAttempts: 1,
    pollCount: 1,
  })
  expect(h.fetcher).toHaveBeenCalledTimes(1)
  await succeeded(f)
  await lateReplay(f, h)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).toHaveBeenCalledTimes(1)
  expect(h.fetcher).toHaveBeenCalledTimes(1)
})

it('fal early barrier observes a committed callback before normal checking without waiting or polling', async () => {
  const f = await faultFixture('fal-callback-early')
  const fake = faultProvider()
  let callbackStoredAt = ''
  const h = harness(fake, {
    start: f.start,
    replay: ['submit', 'persist', 'settle-and-notify'],
    onSleep: async (duration, now) => {
      // 模拟验签入口在持久 sleep 期间提交；签名与事务本身由 web 回调集成测试覆盖。
      callbackStoredAt = new Date(now + duration / 2).toISOString()
      const task = await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
        callbackPayload: { jobId: 'job-fixture', result },
      })
      await updateMediaFaultProof(db, task, { callbackStoredAt })
    },
  })
  enableFaults(h)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.submit.mock.calls[0]?.[0].webhookUrl).toContain('/api/webhooks/media/')
  expect(h.sleeps).toEqual([2_000])
  expect(h.waits).toEqual([])
  expect(fake.getStatus).not.toHaveBeenCalled()
  const proof = await faultProof(f)
  expect(proof).toMatchObject({
    mode: 'fal-callback-early',
    injected: true,
    realProviderCalled: true,
    realRequestId: 'job-fixture',
    submitAttempts: 1,
    pollCount: 0,
    callbackStoredAt,
  })
  expect(Date.parse(proof?.callbackStoredAt ?? '')).toBeLessThan(
    Date.parse(proof?.callbackCheckedAt ?? ''),
  )
  await succeeded(f)
  await lateReplay(f, h)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).not.toHaveBeenCalled()
  expect(h.fetcher).toHaveBeenCalledTimes(1)
})

it('fal early barrier fails when no callback is committed and never falls back to successful polling', async () => {
  const f = await faultFixture('fal-callback-early')
  const fake = faultProvider()
  const h = harness(fake, {
    start: f.start,
    // 模拟第一次唤醒延迟到期限前一秒，保留真实十分钟策略和最后一次探测。
    onSleep: (duration, now) => (now === f.start ? f.fault.barrierMs - 1_000 : duration),
  })
  enableFaults(h)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.now()).toBe(f.start + 10 * 60_000)
  expect(h.sleeps).toEqual([2_000, 1_000])
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).not.toHaveBeenCalled()
  expect(h.waits).toEqual([])
  expect(h.fetcher).not.toHaveBeenCalled()
  expect(await faultProof(f)).toMatchObject({ injected: false, realRequestId: 'job-fixture' })
  expect((await state(f)).task.errorCode).toBe('MEDIA_CALLBACK_EARLY_NOT_OBSERVED')
  await refunded(f)
})

it.each(['fal-submit-response-lost', 'fal-provider-error', 'fal-timeout'] as const)(
  '%s preserves one original request ID, refunds and ignores late success or workflow replay',
  async (mode) => {
    const f = await faultFixture(mode)
    const fake = faultProvider()
    const h = harness(fake, {
      start: f.start,
      replay: ['submit', 'fail-and-notify'],
      onWait: async () => {
        // 即使出现晚到成功，失败注入也只能处理原作业的故障分支。
        await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
          callbackPayload: { jobId: 'job-fixture', result },
        })
      },
    })
    enableFaults(h)
    await runMediaTask(f.taskId, h.step, h.deps)
    expect(fake.submit).toHaveBeenCalledTimes(1)
    expect(fake.submit.mock.calls[0]?.[0].webhookUrl).toBeUndefined()
    const proof = await faultProof(f)
    expect(proof).toMatchObject({
      mode,
      policyVersion: 1,
      injected: true,
      realProviderCalled: true,
      realRequestId: 'job-fixture',
      submitAttempts: 1,
      cancellation: { status: 'cancellation-requested' },
    })
    expect(fake.cancel).toHaveBeenCalledWith('job-fixture')
    expect(fake.cancel).toHaveBeenCalledTimes(1)
    if (mode === 'fal-submit-response-lost') {
      expect((await state(f)).task).toMatchObject({
        providerJobId: null,
        errorCode: 'MEDIA_SUBMISSION_UNCERTAIN',
      })
      expect(proof?.pollCount).toBe(0)
      expect(fake.getStatus).not.toHaveBeenCalled()
      // 故障模式的不确定等待沿用其初始等待，晚到的成功回调也不能被采用。
      expect(h.waits).toEqual([{ type: MEDIA_DONE_EVENT, timeoutMs: 5_000 }])
    } else {
      expect(h.waits).toEqual([{ type: MEDIA_DONE_EVENT, timeoutMs: 5_000 }])
      expect(fake.getStatus).toHaveBeenCalledTimes(mode === 'fal-timeout' ? 2 : 1)
      expect(proof?.pollCount).toBe(mode === 'fal-timeout' ? 2 : 1)
      if (mode === 'fal-timeout') {
        expect(h.sleeps).toEqual([30_000, 25_000])
        expect(h.now()).toBe(f.start + 60_000)
        expect((await state(f)).task.errorCode).toBe('MEDIA_TIMEOUT')
      }
    }
    expect(h.fetcher).not.toHaveBeenCalled()
    expect((await state(f)).files).toEqual([])
    await refunded(f)
    await lateReplay(f, h)
    expect(fake.submit).toHaveBeenCalledTimes(1)
    expect((await faultProof(f))?.realRequestId).toBe('job-fixture')
    expect((await state(f)).files).toEqual([])
  },
)

it.each([
  { providerStatus: 'succeeded', cancellationStatus: 'already-terminal' },
  { providerStatus: 'queued', cancellationStatus: 'unconfirmed' },
] as const)(
  'failed cancellation reads the unwrapped original $providerStatus status as $cancellationStatus',
  async ({ providerStatus, cancellationStatus }) => {
    const f = await faultFixture('fal-provider-error')
    const fake = faultProvider()
    fake.cancel.mockRejectedValue(new Error('Cancellation unavailable'))
    fake.getStatus.mockResolvedValue(
      providerStatus === 'succeeded' ? { status: 'succeeded', result } : { status: 'queued' },
    )
    const h = harness(fake, { start: f.start })
    enableFaults(h)
    await runMediaTask(f.taskId, h.step, h.deps)
    expect(fake.submit).toHaveBeenCalledTimes(1)
    expect(fake.cancel).toHaveBeenCalledTimes(1)
    expect(fake.getStatus).toHaveBeenCalledTimes(2)
    expect(await faultProof(f)).toMatchObject({
      pollCount: 1,
      cancellation: { status: cancellationStatus, providerStatus },
    })
    await refunded(f)
    expect((await state(f)).files).toEqual([])
  },
)

it.each(['missing', 'disabled'] as const)(
  'a %s jobs gate refunds a frozen fault task before constructing or calling a provider',
  async (gate) => {
    const f = await faultFixture('fal-callback-lost')
    const fake = faultProvider()
    const h = harness(fake, { start: f.start })
    if (gate === 'disabled')
      h.deps.faultEnv = { SENTRY_ENVIRONMENT: 'staging', AI_FAULT_INJECTION: 'disabled' }
    const construct = vi.spyOn(h.deps, 'provider')
    await runMediaTask(f.taskId, h.step, h.deps)
    expect(construct).not.toHaveBeenCalled()
    expect(fake.submit).not.toHaveBeenCalled()
    expect(fake.getStatus).not.toHaveBeenCalled()
    expect(h.fetcher).not.toHaveBeenCalled()
    expect((await state(f)).files).toEqual([])
    await refunded(f)
  },
)

it('disabling the jobs gate after submission refunds before polling or invoking cancellation', async () => {
  const f = await faultFixture('fal-timeout')
  const fake = faultProvider()
  const h = harness(fake, {
    start: f.start,
    onWait: async () => {
      h.deps.faultEnv = { SENTRY_ENVIRONMENT: 'staging', AI_FAULT_INJECTION: 'disabled' }
    },
  })
  enableFaults(h)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(fake.submit).toHaveBeenCalledTimes(1)
  expect(fake.getStatus).not.toHaveBeenCalled()
  expect(fake.cancel).not.toHaveBeenCalled()
  expect(h.fetcher).not.toHaveBeenCalled()
  expect(await faultProof(f)).toMatchObject({
    injected: false,
    realProviderCalled: true,
    realRequestId: 'job-fixture',
    submitAttempts: 1,
    pollCount: 0,
  })
  await refunded(f)
  expect((await state(f)).files).toEqual([])
})

it('an invalid frozen fault policy is rejected before provider construction and refunds the hold', async () => {
  const f = await faultFixture('fal-callback-lost')
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    input: { ...task.input, acceptanceFault: { ...f.fault, deadlineMs: 1 } },
  })
  const fake = faultProvider()
  const h = harness(fake, { start: f.start })
  enableFaults(h)
  const construct = vi.spyOn(h.deps, 'provider')
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(construct).not.toHaveBeenCalled()
  expect(fake.submit).not.toHaveBeenCalled()
  expect((await state(f)).task.errorCode).toBe('MEDIA_INPUT_INVALID')
  await refunded(f)
})

// add-media-provider-fallback 5.2 / 5.4 / 5.5：Runner 中的服务商切换。
async function withFailover(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { deadlineInMs?: number; primary?: { provider: string; providerModelId: string } } = {},
) {
  const tenant = scoped(db, f.workspaceId)
  const task = await tenant.findById(aiTask, f.taskId)
  const primary = options.primary ?? { provider: 'fake', providerModelId: 'fake/image' }
  const input = task.input as { params: Record<string, unknown> }
  await tenant.updateById(aiTask, f.taskId, {
    ...primary,
    input: {
      ...task.input,
      providerModelId: primary.providerModelId,
      failover: {
        candidates: [
          { modelKey: task.modelKey, ...primary, params: input.params, fileParams: [] },
          {
            modelKey: 'backup-image',
            provider: 'backup',
            providerModelId: 'backup/image',
            params: { count: input.params.num_images },
            fileParams: [],
          },
        ],
        skipped: [],
      },
    },
    providerAttempts: [{ modelKey: task.modelKey, ...primary, at: new Date().toISOString() }],
    ...(options.deadlineInMs === undefined
      ? {}
      : { deadlineAt: new Date(Date.now() + options.deadlineInMs) }),
  })
}

/** 按任务当前服务商取 Provider，参数取当前尝试（备用为改名后的副本）。 */
function failoverHarness(
  primary: TaskMediaProvider,
  backup: TaskMediaProvider,
  options: Parameters<typeof harness>[1] = {},
) {
  const h = harness(primary, options)
  h.deps.provider = (task) => (task.provider === 'backup' ? backup : primary)
  h.deps.params = async (task) => mediaAttemptRequest(task).params
  return h
}

const rateLimited = () => new FalProviderError('FAL_RATE_LIMITED', 'Rate limited', 429, 'rejected')

async function attempts(f: Awaited<ReturnType<typeof fixture>>) {
  return (await scoped(db, f.workspaceId).findById(aiTask, f.taskId)).providerAttempts
}

it('主服务商限流：切到备用重新提交并成功，新请求键与带序号的回调地址，按主模型快照结算', async () => {
  const f = await fixture()
  await withFailover(f)
  const primary = provider()
  primary.submit.mockRejectedValue(rateLimited())
  const backup = { ...provider(), id: 'backup' }
  backup.submit.mockResolvedValue({ jobId: 'backup-job' })
  const h = failoverHarness(primary, backup, {
    replay: ['failover-a0', 'submit-a1', 'persist-a1', 'settle-and-notify-a1'],
  })
  const logged = vi.spyOn(console, 'log')
  expect(await runMediaTask(f.taskId, h.step, h.deps)).toEqual({
    taskId: f.taskId,
    status: 'succeeded',
  })
  // 限流不在同一服务商重试，直接切换。
  expect(primary.submit).toHaveBeenCalledTimes(1)
  expect(backup.submit).toHaveBeenCalledTimes(1)
  const submitted = backup.submit.mock.calls[0]?.[0]
  expect(submitted).toMatchObject({
    modelId: 'backup/image',
    params: { count: 5 },
    idempotencyKey: `${f.taskId}:a1`,
  })
  expect(new URL(submitted?.webhookUrl ?? '').searchParams.get('attempt')).toBe('1')
  expect(backup.getStatus).toHaveBeenCalledWith('backup-job')
  expect(h.names).toEqual(
    expect.arrayContaining(['submit', 'failover-a0', 'submit-a1', 'poll-0-a1', 'persist-a1']),
  )
  // 备用模型的价格不参与结算：仍按主模型的 15 积分快照扣费一次。
  await succeeded(f)
  const task = (await state(f)).task
  expect(task).toMatchObject({
    provider: 'backup',
    providerJobId: 'backup-job',
    providerRequestKey: `${f.taskId}:a1`,
    input: { params: { num_images: 5 }, providerModelId: 'backup/image' },
  })
  expect(task.providerAttempts).toEqual([
    expect.objectContaining({
      provider: 'fake',
      failure: { kind: 'rate_limited', code: 'FAL_RATE_LIMITED' },
    }),
    expect.objectContaining({ provider: 'backup', modelKey: 'backup-image', jobId: 'backup-job' }),
  ])
  const failover = logged.mock.calls
    .map(([line]) => String(line))
    .find((line) => line.includes('ai.media.failover'))
  expect(JSON.parse(failover ?? '{}')).toMatchObject({
    event: 'ai.media.failover',
    taskId: f.taskId,
    from: 'fake:frozen-image',
    to: 'backup:backup-image',
    kind: 'rate_limited',
  })
  expect(failover).not.toMatch(/num_images|count/)
  logged.mockRestore()
})

it('作业以服务商侧原因失败：切到备用并成功；运行时服务商未配置的尝试同样切换', async () => {
  for (const cause of ['job-failed', 'unconfigured'] as const) {
    const f = await fixture()
    await withFailover(f)
    const primary = provider()
    primary.getStatus.mockResolvedValue({
      status: 'failed',
      error: { code: 'FAL_GENERATION_FAILED', message: 'Upstream failure' },
    })
    const backup = { ...provider(), id: 'backup' }
    const h = failoverHarness(primary, backup)
    if (cause === 'unconfigured')
      h.deps.provider = (task) => {
        if (task.provider === 'backup') return backup
        throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'Media provider is not configured', {
          status: 503,
        })
      }
    await runMediaTask(f.taskId, h.step, h.deps)
    expect(primary.submit).toHaveBeenCalledTimes(cause === 'job-failed' ? 1 : 0)
    expect(backup.submit).toHaveBeenCalledTimes(1)
    await succeeded(f)
    expect((await attempts(f))[0]?.failure).toEqual(
      cause === 'job-failed'
        ? { kind: 'provider_error', code: 'FAL_GENERATION_FAILED' }
        : { kind: 'unavailable', code: 'AI_PROVIDER_NOT_CONFIGURED' },
    )
  }
})

it('内容审核拒绝不切换：任务失败并全额退回，备用服务商不被调用', async () => {
  const f = await fixture()
  await withFailover(f)
  const primary = provider()
  primary.getStatus.mockResolvedValue({
    status: 'failed',
    error: { code: 'FAL_CONTENT_POLICY', message: 'Blocked', kind: 'content_policy' },
  })
  const backup = { ...provider(), id: 'backup' }
  const h = failoverHarness(primary, backup)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(backup.submit).not.toHaveBeenCalled()
  await refunded(f)
  expect((await state(f)).task.errorCode).toBe('FAL_CONTENT_POLICY')
  expect((await attempts(f)).map(({ failure }) => failure)).toEqual([
    { kind: 'content_policy', code: 'FAL_CONTENT_POLICY' },
  ])
})

it.each([
  ['fal 5xx', () => new FalProviderError('FAL_HTTP_ERROR', 'Bad gateway', 502, 'ambiguous')],
  [
    'Replicate 5xx',
    () =>
      new ReplicateProviderError('provider_error', 'REPLICATE_HTTP_ERROR', 'Bad gateway', {
        httpStatus: 502,
        submissionOutcome: 'ambiguous',
      }),
  ],
])('%s 提交结果不确定：走提交确认中，不重提也不切换', async (_name, error) => {
  const f = await fixture()
  await withFailover(f)
  const primary = provider()
  primary.submit.mockRejectedValue(error())
  const backup = { ...provider(), id: 'backup' }
  const h = failoverHarness(primary, backup)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(primary.submit).toHaveBeenCalledTimes(1)
  expect(backup.submit).not.toHaveBeenCalled()
  await refunded(f)
  expect((await state(f)).task.errorCode).toBe('MEDIA_SUBMISSION_UNCERTAIN')
})

it('备用全部失败：全额退回，失败原因记录最后一次错误，每次尝试都有失败分类', async () => {
  const f = await fixture()
  await withFailover(f)
  const primary = provider()
  primary.submit.mockRejectedValue(rateLimited())
  const backup = { ...provider(), id: 'backup' }
  backup.getStatus.mockResolvedValue({
    status: 'failed',
    error: { code: 'REPLICATE_PREDICTION_FAILED', message: 'Prediction failed' },
  })
  const h = failoverHarness(primary, backup)
  await runMediaTask(f.taskId, h.step, h.deps)
  await refunded(f)
  expect((await state(f)).task).toMatchObject({
    errorCode: 'REPLICATE_PREDICTION_FAILED',
    errorMessage: 'Prediction failed',
  })
  expect((await attempts(f)).map(({ provider, failure }) => ({ provider, failure }))).toEqual([
    { provider: 'fake', failure: { kind: 'rate_limited', code: 'FAL_RATE_LIMITED' } },
    {
      provider: 'backup',
      failure: { kind: 'provider_error', code: 'REPLICATE_PREDICTION_FAILED' },
    },
  ])
})

it('距硬超时不足 20 分钟不切换：按原规则在同一服务商重试后失败退款', async () => {
  const f = await fixture()
  await withFailover(f, { deadlineInMs: 15 * 60_000 })
  const primary = provider()
  primary.submit.mockRejectedValue(rateLimited())
  const backup = { ...provider(), id: 'backup' }
  const h = failoverHarness(primary, backup)
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(backup.submit).not.toHaveBeenCalled()
  expect(primary.submit).toHaveBeenCalledTimes(4)
  await refunded(f)
  expect((await state(f)).task.errorCode).toBe('FAL_RATE_LIMITED')
})

it.each(['fal-rate-limited', 'fal-failover-job-failed'] as const)(
  '故障注入 %s 只影响首个尝试，备用模型完成任务',
  async (mode) => {
    const f = await fixture()
    const start = Date.now()
    const fault = mediaFaultPolicy(mode)
    const tenant = scoped(db, f.workspaceId)
    const task = await tenant.findById(aiTask, f.taskId)
    await tenant.updateById(aiTask, f.taskId, {
      modelKey: `acceptance-fault-${mode}`,
      input: {
        ...task.input,
        params: { image_size: 'square', num_images: 1 },
        unitsLimit: 1,
        acceptanceFault: { ...fault },
        acceptanceFaultProof: { ...initialMediaFaultProof(fault) },
      },
      deadlineAt: new Date(start + fault.deadlineMs),
    })
    await withFailover(f, { primary: { provider: 'fal', providerModelId: 'fal-ai/flux/schnell' } })
    const primary = faultProvider()
    const backup = { ...provider(), id: 'backup' }
    const h = failoverHarness(primary, backup, { start })
    h.deps.provider = (current) => (current.provider === 'backup' ? backup : primary)
    enableFaults(h)
    await runMediaTask(f.taskId, h.step, h.deps)
    expect(primary.submit).toHaveBeenCalledTimes(mode === 'fal-rate-limited' ? 0 : 1)
    if (mode === 'fal-failover-job-failed')
      // 真实作业保留回调地址（序号 0），晚到回调会被识别为旧尝试。
      expect(primary.submit.mock.calls[0]?.[0].webhookUrl).not.toContain('attempt=')
    expect(backup.submit).toHaveBeenCalledTimes(1)
    expect(backup.submit.mock.calls[0]?.[0].webhookUrl).toContain('attempt=1')
    expect(await faultProof(f)).toMatchObject({ mode, injected: true })
    await succeeded(f)
  },
)

/** 首次运行时缓存的 load-task 结果：提交前的任务快照。 */
async function loadTaskSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return JSON.stringify(await scoped(db, f.workspaceId).findById(aiTask, f.taskId))
}

it.each(['submitted', 'uncertain'] as const)(
  '重放时主服务商凭据被移除：首个尝试已%s，不切换、不向备用重复提交',
  async (stage) => {
    const f = await fixture()
    await withFailover(f)
    const snapshot = await loadTaskSnapshot(f)
    // 首次运行已向 fal 提交（或提交确认中），之后运维移除了 FAL_KEY，Workflow 重放。
    await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
      status: 'running',
      output: { submissionAttempted: true },
      ...(stage === 'submitted'
        ? { providerJobId: 'job-fixture' }
        : { errorCode: 'MEDIA_SUBMISSION_UNCERTAIN' }),
    })
    const backup = { ...provider(), id: 'backup' }
    const h = failoverHarness(provider(), backup, { cached: { 'load-task': snapshot } })
    h.deps.provider = (task) => {
      if (task.provider === 'backup') return backup
      throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'Media provider is not configured', {
        status: 503,
      })
    }
    await runMediaTask(f.taskId, h.step, h.deps)
    expect(backup.submit).not.toHaveBeenCalled()
    const { task } = await state(f)
    expect(task).toMatchObject({ status: 'failed', provider: 'fake' })
    expect(task.errorCode).toBe('AI_PROVIDER_NOT_CONFIGURED')
    expect(task.providerAttempts).toHaveLength(1)
  },
)

it('重放时数据库已切到备用：按数据库当前尝试继续，不再向主服务商提交', async () => {
  const f = await fixture()
  await withFailover(f)
  const snapshot = await loadTaskSnapshot(f)
  // 首次运行：主服务商不可用而切到备用，备用已受理；之后主服务商凭据恢复，Workflow 重放。
  const switched = await switchMediaTaskAttempt(
    db,
    { workspaceId: f.workspaceId, id: f.taskId },
    {
      attempt: 0,
      failure: { kind: 'unavailable', code: 'AI_PROVIDER_NOT_CONFIGURED' },
      now: Date.now(),
    },
  )
  expect(switched.status).toBe('switched')
  await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    status: 'running',
    providerJobId: 'backup-job',
    output: { submissionAttempted: true },
  })
  const primary = provider()
  const backup = { ...provider(), id: 'backup' }
  const h = failoverHarness(primary, backup, { cached: { 'load-task': snapshot } })
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(primary.submit).not.toHaveBeenCalled()
  expect(primary.getStatus).not.toHaveBeenCalled()
  expect(backup.submit).not.toHaveBeenCalled()
  expect(backup.getStatus).toHaveBeenCalledWith('backup-job')
  expect(h.names).not.toContain('submit')
  expect(h.names).toContain('submit-a1')
  await succeeded(f)
})

it('旧尝试残留的唤醒事件不结束当前尝试的等待：提交确认中仍等到本尝试的回调', async () => {
  const f = await fixture()
  await withFailover(f)
  const primary = provider()
  primary.submit.mockRejectedValue(rateLimited())
  const backup = { ...provider(), id: 'backup' }
  backup.submit.mockRejectedValue(
    new ReplicateProviderError('provider_error', 'REPLICATE_HTTP_ERROR', 'Bad gateway', {
      httpStatus: 502,
      submissionOutcome: 'ambiguous',
    }),
  )
  const h = failoverHarness(primary, backup, {
    events: async (name) => {
      // 首轮收到序号 0 的残留事件；下一轮本尝试的回调才到达。
      if (name === 'wait-uncertain-callback-a1') return { taskId: f.taskId, attempt: 0 }
      if (name === 'wait-uncertain-callback-1-a1') {
        await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
          callbackPayload: { jobId: 'backup-job', result },
        })
        return { taskId: f.taskId, attempt: 1 }
      }
      return undefined
    },
  })
  await runMediaTask(f.taskId, h.step, h.deps)
  expect(h.names).toEqual(
    expect.arrayContaining(['wait-uncertain-callback-a1', 'wait-uncertain-callback-1-a1']),
  )
  expect(backup.submit).toHaveBeenCalledTimes(1)
  await succeeded(f)
  expect((await state(f)).task.providerJobId).toBe('backup-job')
})

it('旧尝试残留事件到达时，回调等待按原定截止时间继续，随后照常轮询', async () => {
  const f = await fixture()
  await withFailover(f)
  const primary = provider()
  primary.submit.mockRejectedValue(rateLimited())
  const backup = { ...provider(), id: 'backup' }
  const h = failoverHarness(primary, backup, {
    events: (name) =>
      name === 'wait-media-done-a1' ? { taskId: f.taskId, attempt: 0 } : undefined,
  })
  await runMediaTask(f.taskId, h.step, h.deps)
  // 首轮被残留事件唤醒后继续等待余下的 15 分钟，而不是立即轮询。
  expect(h.names).toEqual(expect.arrayContaining(['wait-media-done-a1', 'wait-media-done-1-a1']))
  const resumed = h.waits.at(-1)?.timeoutMs ?? 0
  expect(resumed).toBeGreaterThan(14 * 60_000)
  expect(resumed).toBeLessThan(15 * 60_000)
  await succeeded(f)
})
