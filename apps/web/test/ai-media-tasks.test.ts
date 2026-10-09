import { env } from 'cloudflare:workers'
import {
  MEDIA_HOLD_SWEEP_BUFFER_MS,
  type MediaProvider,
  type MediaWebhook,
  mediaCallbackUrl,
} from '@saas/ai'
import { createAuth } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { getCreditBalance, grant } from '@saas/credits'
import { aiModel, aiTask, createDb, file, member as membership, scoped } from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { AppError, newId } from '@saas/shared'
import { afterAll, describe, expect, it } from 'vitest'
import {
  handleMediaCancel,
  handleMediaDetail,
  handleMediaList,
  handleMediaSubmit,
  handleMediaWebhook,
  type MediaHttpDeps,
} from '../src/features/ai/media-tasks.ts'

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
async function model(extra: Record<string, unknown> = {}) {
  const key = `${MODEL_PREFIX}${newId()}`
  await db.insert(aiModel).values({
    key,
    kind: 'image',
    provider: 'fal',
    providerModelId: 'fal-ai/fixture',
    pricing: { mode: 'per_call', credits: 3 },
    paramsSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        num_images: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
        ...extra,
      },
    },
  })
  return key
}
function dependencies(
  options: {
    max?: number
    startFails?: boolean
    cancelFails?: boolean
    callback?: MediaWebhook
    invalidProviderSignature?: boolean
  } = {},
) {
  let parsed = 0
  let canceled = 0
  let terminated = 0
  let events = 0
  const provider: MediaProvider = {
    id: 'fal',
    capabilities: { idempotentSubmit: false },
    submit: async () => ({ jobId: 'unused' }),
    getStatus: async () => ({ status: 'queued' }),
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
    rateLimiter: { limit: async () => ({ success: true }) },
    providerFactory: () => provider,
    entitlements: async () => ({
      key: 'fixture',
      sort: 0,
      features: { ...DEFAULT_FREE_FEATURES, models: ['*'], maxConcurrentTasks: options.max ?? 3 },
    }),
    workflow: {
      create: async () => {
        if (options.startFails) throw new Error('fixture start unavailable')
        return {}
      },
      get: async (instanceId: string) => ({
        status: async () => ({ status: terminated > 0 ? 'terminated' : 'running' }),
        terminate: async () => {
          terminated++
        },
        sendEvent: async () => {
          events++
          const [stored] =
            await sql`select callback_payload from ai_task where workflow_instance_id=${instanceId}`
          expect(stored?.callback_payload).not.toBeNull()
          throw new Error('fixture delivery unavailable')
        },
      }),
    } as unknown as MediaHttpDeps['workflow'],
  }
  return { deps, counts: () => ({ parsed, canceled, terminated, events }) }
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
})

describe('media tasks API', () => {
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
